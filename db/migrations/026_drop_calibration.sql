-- 026: removes the corpus-calibration experiment.
--
-- 024 (embedding_reference) and 025 (search_observations) backed an attempt to
-- derive the semantic abstention threshold from each vault's own contents. It
-- was measured and it failed: a background built from the vault's own text —
-- titles first, then sentences — scores HIGHER than the questions people
-- actually ask, so a correct answer read as ordinary and got suppressed. The
-- reasoning is kept where it is acted on: the note above minSimilarityFor in
-- lib/embeddings.ts.
--
-- Dropped rather than left empty. A dormant mechanism with a schema behind it
-- is an invitation to switch it back on in six months without knowing it was
-- already disproved.
--
-- Both migrations shipped and ran on 2026-08-19 only, so this touches nothing
-- older than that day; `if exists` keeps it a no-op for installs that never saw
-- them.
drop table if exists search_observations;
drop table if exists embedding_reference;

-- The stored null distribution lived in settings rather than a table.
delete from settings where key = 'semantic_null';

-- `embedding_bands` is deliberately left alone. Its `gate` half is still how
-- someone running an unprofiled model supplies a threshold; a stale
-- `signalFloor` next to it is simply never read again (lib/settings.ts keeps
-- only the gate), so rewriting user rows to tidy a key nothing looks at would
-- be more risk than the tidiness is worth.
