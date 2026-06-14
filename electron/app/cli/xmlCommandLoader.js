const fs = require('fs');
const { parseXmlDocument } = require('./xmlUtils');

function parseBool(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

class XmlCommandLoader {
    constructor(tree) {
        this.tree = tree;
    }

    load(xmlPath) {
        const root = parseXmlDocument(fs.readFileSync(xmlPath, 'utf8'));
        this.loadViews(root);
        this.loadCommands(root);
    }

    loadViews(root) {
        const views = root.child('views');
        if (!views) {
            return;
        }

        views.childrenByName('view').forEach(view => {
            this.tree.ensureView(view.attr('name'), view.childText('prompt', '<NetNexus>'));
        });
    }

    loadCommands(root) {
        const commands = root.child('commands');
        if (!commands) {
            return;
        }

        commands.childrenByName('command').forEach(commandNode => {
            const command = {
                id: commandNode.attr('id'),
                handler: commandNode.attr('handler'),
                views: commandNode.attr('views', 'global').split(',').map(item => item.trim()).filter(Boolean),
                syntax: commandNode.childText('syntax'),
                description: commandNode.childText('description'),
                toView: commandNode.attr('to-view') || null,
                clearContext: parseBool(commandNode.attr('clear-context')),
                context: this.parseContext(commandNode.child('context'))
            };

            if (command.id && command.handler && command.syntax) {
                this.tree.registerCommand(command);
            }
        });
    }

    parseContext(contextNode) {
        if (!contextNode) {
            return [];
        }
        return contextNode.childrenByName('entry').map(entry => ({
            name: entry.attr('name'),
            fromArg: entry.attr('from-arg') || null,
            value: entry.attr('value') || null
        }));
    }
}

module.exports = XmlCommandLoader;
