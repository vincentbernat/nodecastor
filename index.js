'use strict';

var nodecastor = module.exports = {
  discover: function() {
    return new nodecastor.Discoverer();
  },
  Discoverer: require('./lib/discover'),
  Chromecast: require('./lib/chromecast')
};
