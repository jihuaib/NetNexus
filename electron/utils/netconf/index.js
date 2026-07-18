'use strict';

const framing = require('./framing');
const xml = require('./xml');
const subtreeFilter = require('./subtreeFilter');
const builders = require('./builders');
const inventory = require('./inventory');
const sshTransport = require('./sshTransport');
const client = require('./client');

module.exports = {
    ...framing,
    ...xml,
    ...subtreeFilter,
    ...builders,
    ...inventory,
    ...sshTransport,
    ...client
};
