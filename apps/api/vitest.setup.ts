// Per-worker setup. All logic (dotenv load, digilog_test_db redirect, JWT
// secrets) lives in the shared bootstrap so it stays identical to the
// global-setup context. Imported for its side effects only.
import './vitest.env.js';
