const fs = require('fs');
const { parseXmlDocument } = require('./xmlUtils');
const ParamType = require('./paramTypes');

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
        const commandGroups = root.child('command_groups');
        if (!commandGroups) {
            throw new Error('CLI command XML must contain command_groups');
        }
        this.loadCommandGroups(commandGroups);
    }

    loadCommandGroups(commandGroups) {
        commandGroups.childrenByName('group').forEach(groupNode => {
            const groupId = groupNode.attr('group-id');
            if (!groupId) {
                throw new Error('CLI command group requires group-id');
            }

            const elements = this.parseElements(groupNode.child('elements'));
            const commands = groupNode.child('commands');
            if (!commands) {
                return;
            }

            commands.childrenByName('command').forEach(commandNode => {
                const sequence = this.parseExpression(commandNode.childText('expression'), elements);
                const command = {
                    groupId,
                    views: this.parseViews(commandNode),
                    syntax: sequence.map(token => token.name).join(' '),
                    sequences: [sequence],
                    description: commandNode.childText('description'),
                    toView: null,
                    clearContext: false,
                    context: []
                };

                if (sequence.length > 0) {
                    this.tree.registerCommand(command);
                }
            });
        });
    }

    parseElements(elementsNode) {
        const elements = new Map();
        if (!elementsNode) {
            return elements;
        }

        elementsNode.childrenByName('element').forEach(elementNode => {
            const id = elementNode.attr('id');
            if (!id) {
                return;
            }

            elements.set(id, this.parseElement(elementNode));
        });
        return elements;
    }

    parseElement(elementNode) {
        const name = elementNode.childText('name');
        const description = elementNode.childText('description');
        const elementType = elementNode.attr('type', 'keyword');
        const cfgId = elementNode.attr('cfg-id') || null;

        if (elementType === 'parameter') {
            if (!cfgId) {
                throw new Error(`Parameter element ${elementNode.attr('id')} requires cfg-id`);
            }
            const typeStr = elementNode.childText('type', 'string(0-255)');
            return {
                type: 'argument',
                name,
                description,
                argName: `cfg${cfgId}`,
                cfgId,
                paramType: new ParamType(typeStr)
            };
        }

        return {
            type: 'command',
            name,
            description,
            cfgId
        };
    }

    parseExpression(expression, elements) {
        return String(expression || '')
            .trim()
            .split(/\s+/u)
            .filter(Boolean)
            .map(id => {
                const element = elements.get(id);
                if (!element) {
                    throw new Error(`Command expression references unknown element id: ${id}`);
                }
                return { ...element };
            });
    }

    parseViews(commandNode) {
        const views = commandNode.attr('views') || commandNode.childText('views', 'global');
        return views
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
    }
}

module.exports = XmlCommandLoader;
