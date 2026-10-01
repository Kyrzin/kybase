// lib/mcp-server.ts — MCP server factory with 18 tools
// Uses @modelcontextprotocol/sdk McpServer (high-level API)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNoteReadTools } from './mcp/notes-read';
import { registerNoteWriteTools } from './mcp/notes-write';
import { registerSearchTools } from './mcp/search';
import { registerOrganizeTools } from './mcp/organize';
import { registerGraphTools } from './mcp/graph';

export { sectionRange, resolveInsertOffset, insertAddition, countOccurrences, windowContent } from './mcp/text-edit';
export type { AppendAt } from './mcp/text-edit';


/** Shape every tool handler returns; enough of it to log an outcome. */
type ToolReply = { isError?: boolean; content?: { text?: string }[] };

/**
 * One stderr line per tool call: what was called, whether it worked, how much
 * came back, how long it took.
 *
 * Nothing on this path used to log at all, which made every "how often does
 * this actually happen" question unanswerable — the size of a reply, the rate
 * of refusals and which tools agents reach for were all invisible to the
 * person running the server. `docker logs` is where that belongs.
 *
 * Wrapped at the server rather than at each registration so a tool added
 * later is logged without anyone remembering to, and so the eighteen call
 * sites below stay about the tools instead of about logging.
 *
 * Deliberately never logs arguments or reply text — a query string and a note
 * body are the two things most worth not writing to a log file. Length is the
 * part that answers the question. stderr, because in stdio mode stdout
 * carries JSON-RPC framing and nothing else.
 */
function logToolCalls(server: McpServer): void {
  const wrap = (register: (...a: unknown[]) => unknown) => (...args: unknown[]) => {
    const name = String(args[0]);
    const last = args.length - 1;
    const handler = args[last];
    if (typeof handler === 'function') {
      const inner = handler as (...a: unknown[]) => Promise<ToolReply>;
      args[last] = async (...callArgs: unknown[]): Promise<ToolReply> => {
        const started = Date.now();
        const done = (outcome: string, chars: number) =>
          console.error(`[mcp] ${name} ${outcome} ${chars}ch ${Date.now() - started}ms`);
        try {
          const reply = await inner(...callArgs);
          const chars = reply?.content?.reduce((n, c) => n + (c.text?.length ?? 0), 0) ?? 0;
          done(reply?.isError ? 'error' : 'ok', chars);
          return reply;
        } catch (err) {
          // A throw becomes an isError reply one layer up, so it is the same
          // event to a caller and has to read the same way here — including
          // its size. A refusal that lists every heading in a note is not a
          // cheap reply, and a log that called every error 0ch would hide
          // exactly the ones worth finding.
          done('error', err instanceof Error ? err.message.length : 0);
          throw err;
        }
      };
    }
    return register.apply(server, args);
  };
  const s = server as unknown as Record<string, (...a: unknown[]) => unknown>;
  s.tool = wrap(s.tool.bind(server));
  s.registerTool = wrap(s.registerTool.bind(server));
}

export type McpServerOptions = {
  /**
   * Who note history records this server's writes as made by. Called at each
   * write, not once: a stdio client names itself in the initialize handshake,
   * which arrives after the server is built. Defaults to that name.
   */
  actor?: () => string;
};

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'kybase', version: '1.0.0' },
    {
      instructions:
        'Kybase is a personal knowledge base of interlinked markdown notes. Notes reference ' +
        'each other with [[Title]] wikilinks; those links form the knowledge graph.\n\n' +
        'When creating a note or substantially rewriting one:\n' +
        '1. First call search_notes with the note\'s topic to find related existing notes.\n' +
        '2. If genuinely related notes exist, include [[wikilinks]] to the 2-5 most relevant ones in the ' +
        'note body — inline where natural, or as a final "Related: [[A]], [[B]]" line.\n' +
        '3. Copy linked titles VERBATIM from any tool result in this conversation. Never write a ' +
        '[[link]] to a title you have not seen in one — invented ' +
        'or misremembered titles produce broken links. A write that introduces one comes back ' +
        'with `unresolved_links` naming it — fix it there, not hours later.\n' +
        '4. Do not force links: if nothing is related, create the note without any.\n\n' +
        'Tagging: new tags are lowercase, kebab-case, and follow the language already in use. Call ' +
        'list_tags first and reuse an existing tag when one fits, rather than coining a duplicate.\n\n' +
        'To add to a note use append_to_note, not update_note: resending whole content to add a ' +
        'paragraph costs the note twice and overwrites what another session wrote meanwhile. When ' +
        'you do rewrite whole content, pass the updated_at you read as expected_updated_at.\n\n' +
        'Paging: `limit` and `offset` count whatever that tool returns — characters in get_note, ' +
        'hits in search_notes, notes in list_notes, linking notes in get_backlinks. A partial reply ' +
        'always says so, in one of three ways: `has_more` with `next_offset` when there is another ' +
        'page but no honest total; `total` above the rows you got when the real count is knowable; ' +
        '`truncated: true` when a ceiling cut the reply, which means narrow the request rather than ' +
        'raise the ceiling. None of the three present means you have everything there is.\n\n' +
        // Lives here, not in search_notes: it governs every tool that ranks or
        // walks rather than reads, and a rule repeated in three descriptions is
        // paid for in every request instead of once per session.
        'Retrieval is not an answer. search_notes, get_neighbors and get_backlinks return ' +
        'candidates. Before stating something as fact, quote the text you actually read — a ' +
        'relevance value, a similarity or a rerank score is never evidence that a note says what ' +
        'you asked.',
    }
  );

  // Before any registration below — it wraps the registration methods.
  logToolCalls(server);

  const actor = options.actor ?? (() => {
    const client = server.server.getClientVersion()?.name?.trim();
    return client ? `mcp:${client}` : 'mcp';
  });

  registerNoteReadTools(server);
  registerNoteWriteTools(server, actor);
  registerSearchTools(server);
  registerOrganizeTools(server, actor);
  registerGraphTools(server);

  return server;
}
