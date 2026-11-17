'use strict';
// Vercel function: every request (pages and API) is answered by the AgentFlow server code. See server/serverless.js.
const { createHandler } = require('../server/serverless.js');

module.exports = createHandler();
