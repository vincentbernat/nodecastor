'use strict';

var path = require('path'),
    ProtoBuf = require('protobufjs');

const pkg = 'extensions.api.cast_channel';
const root = new ProtoBuf.Root().loadSync(
  path.normalize(path.join(__dirname, 'cast_channel.proto')),
  { keepCase: true }
);

module.exports = {
  CastMessage: root.lookupType(pkg + '.CastMessage'),
  DeviceAuthMessage: root.lookupType(pkg + '.DeviceAuthMessage'),
};
