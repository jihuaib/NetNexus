'use strict';

const framing = require('./framing');
const xml = require('./xml');
const builders = require('./builders');
const inventory = require('./inventory');
const sshTransport = require('./sshTransport');
const client = require('./client');

module.exports = {
    ...framing,
    ...xml,
    ...builders,
    ...inventory,
    ...sshTransport,
    ...client
};
