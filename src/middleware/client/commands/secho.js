const dialog = require('../../helpers/dialog.js');

const secho = (data, middleware) => {
 data.forward.pop();
 const args = data.input.match(/^\s*\w+\s(.+)$/);
 if (args) data.respond.push(`#$#soundpack echo | ${args[1]}`);
 else dialog.prompt({ middleware, title: `What would you like to be repeated back to you using soundpack echo?` }).then(({ data }) => middleware.device.respond(`#$#soundpack echo | ${data.input}`));
};

module.exports = secho;