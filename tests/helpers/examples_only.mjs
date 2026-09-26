// npm test: the suite sees only the committed stand-ins (config/*.example.*, settings.json), never the
// real roster, persona or links of this machine — the same results locally and in a clean clone.
process.env.STANDUP_EXAMPLES_ONLY = '1';
