'use strict';

var nodecastor = module.exports = {
  scan: function() {
    return new nodecastor.Scanner();
  },
  Scanner: require('./lib/scanner'),
  Chromecast: require('./lib/chromecast')
};
