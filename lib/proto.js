'use strict';

var path = require('path'),
    ProtoBuf = require('protobufjs');

module.exports = ProtoBuf
  .loadProtoFile(path.normalize(path.join(__dirname, 'cast_channel.proto')))
  .build('extensions.api.cast_channel');
