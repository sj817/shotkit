const path = require('path');

module.exports = {
  cacheDirectory: path.join(__dirname, '.browsers', 'puppeteer'),
  chrome: {
    skipDownload: true,
  },
  firefox: {
    skipDownload: true,
  },
};
