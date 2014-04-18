'use strict';

var nodecastor = module.exports = {
  scan: function(options) {
    return new nodecastor.Scanner(options);
  },
  Scanner: require('./lib/scanner'),
  CastDevice: require('./lib/device'),
  CastApplication: require('./lib/application'),
  CastSession: require('./lib/session')
};
