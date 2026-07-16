'use strict';

/*
 * Public .txt scenario entry point.
 *
 * Running:
 *   node agent-hybrid-client.js scenario.txt
 *
 * always performs local discovery only.
 *
 * Spec generation is a separate explicit command:
 *   node scripts/generate-spec-from-last-run.js scenario.txt
 */

require('./scripts/run-discovery.js');
