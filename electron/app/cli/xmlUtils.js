class XmlNode {
    constructor(name, attrs = {}) {
        this.name = name;
        this.attrs = attrs;
        this.children = [];
        this.text = '';
    }

    attr(name, defaultValue = '') {
        return this.attrs[name] ?? defaultValue;
    }

    child(name) {
        return this.children.find(item => item.name === name) || null;
    }

    childText(name, defaultValue = '') {
        const child = this.child(name);
        return child ? child.text.trim() : defaultValue;
    }

    childrenByName(name) {
        return this.children.filter(item => item.name === name);
    }
}

function decodeXmlEntities(value) {
    return String(value)
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&amp;/gu, '&')
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'");
}

function parseXmlAttributes(source) {
    const attrs = {};
    const attrRegex = /([A-Za-z0-9_:-]+)\s*=\s*(['"])(.*?)\2/gu;
    let match;
    while ((match = attrRegex.exec(source))) {
        attrs[match[1]] = decodeXmlEntities(match[3]);
    }
    return attrs;
}

function parseXmlDocument(xml) {
    const cleaned = xml.replace(/<\?xml[\s\S]*?\?>/gu, '').replace(/<!--[\s\S]*?-->/gu, '');
    const tokenRegex = /<[^>]+>|[^<]+/gu;
    const stack = [];
    let root = null;
    let match;

    while ((match = tokenRegex.exec(cleaned))) {
        const token = match[0];
        if (!token.startsWith('<')) {
            if (stack.length > 0) {
                stack[stack.length - 1].text += decodeXmlEntities(token);
            }
            continue;
        }

        if (token.startsWith('</')) {
            stack.pop();
            continue;
        }
        if (token.startsWith('<!')) {
            continue;
        }

        const selfClosing = /\/>\s*$/u.test(token);
        const body = token.slice(1, token.length - (selfClosing ? 2 : 1)).trim();
        const spaceIndex = body.search(/\s/u);
        const name = spaceIndex >= 0 ? body.slice(0, spaceIndex) : body;
        const attrSource = spaceIndex >= 0 ? body.slice(spaceIndex + 1) : '';
        const node = new XmlNode(name, parseXmlAttributes(attrSource));

        if (stack.length > 0) {
            stack[stack.length - 1].children.push(node);
        } else {
            root = node;
        }
        if (!selfClosing) {
            stack.push(node);
        }
    }

    if (!root) {
        throw new Error('empty XML document');
    }
    return root;
}

module.exports = {
    parseXmlDocument
};
