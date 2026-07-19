import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const NETCONF_BASE_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:base:1.0';
export const NETCONF_NOTIFICATION_NAMESPACE = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
export const SUBSCRIBED_NOTIFICATIONS_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-subscribed-notifications';
export const YANG_PUSH_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-yang-push';
export const IETF_DATASTORES_NAMESPACE = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
const RFC3339_DATE_TIME_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/iu;

export const rfc3339Timestamp = value => {
    const match = RFC3339_DATE_TIME_PATTERN.exec(String(value || '').trim());
    if (!match) return null;
    const [
        ,
        yearText,
        monthText,
        dayText,
        hourText,
        minuteText,
        secondText,
        fraction = '',
        sign,
        offsetHourText,
        offsetMinuteText
    ] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const offsetHour = Number(offsetHourText || 0);
    const offsetMinute = Number(offsetMinuteText || 0);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > daysInMonth[month - 1] ||
        hour > 23 ||
        minute > 59 ||
        second > 60 ||
        offsetHour > 14 ||
        offsetMinute > 59 ||
        (offsetHour === 14 && offsetMinute !== 0)
    ) {
        return null;
    }
    const milliseconds = Number(`0.${fraction || '0'}`) * 1000;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, Math.min(second, 59), Math.floor(milliseconds));
    const offset = sign ? (offsetHour * 60 + offsetMinute) * 60_000 * (sign === '+' ? 1 : -1) : 0;
    return date.getTime() + (second === 60 ? 1000 : 0) - offset;
};

export const isRfc3339DateTime = value => rfc3339Timestamp(value) !== null;

const XML_PARSE_OPTIONS = Object.freeze({
    allowBooleanAttributes: false,
    commentPropName: '#comment',
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    processEntities: false,
    trimValues: false
});

const locationAt = (value, rawIndex) => {
    const text = String(value ?? '');
    const index = Math.max(0, Math.min(Number(rawIndex) || 0, text.length));
    let line = 1;
    let lineStart = 0;

    for (let cursor = 0; cursor < index; cursor += 1) {
        if (text[cursor] === '\n') {
            line += 1;
            lineStart = cursor + 1;
        }
    }

    return {
        index,
        line,
        column: index - lineStart + 1
    };
};

const indexAt = (value, rawLine, rawColumn) => {
    const text = String(value ?? '');
    const targetLine = Math.max(1, Number(rawLine) || 1);
    const targetColumn = Math.max(1, Number(rawColumn) || 1);
    let line = 1;
    let index = 0;

    while (line < targetLine && index < text.length) {
        if (text[index] === '\n') line += 1;
        index += 1;
    }

    return Math.min(index + targetColumn - 1, text.length);
};

const diagnosticAt = (value, message, index, length = 1) => ({
    severity: 'error',
    message,
    ...locationAt(value, index),
    length: Math.max(0, Math.min(Number(length) || 0, String(value ?? '').length - Math.max(0, index)))
});

const scanXmlTags = value => {
    const text = String(value ?? '');
    const tags = [];
    let cursor = 0;
    let depth = 0;

    while (cursor < text.length) {
        const openIndex = text.indexOf('<', cursor);
        if (openIndex < 0) break;

        if (text.startsWith('<!--', openIndex)) {
            const end = text.indexOf('-->', openIndex + 4);
            cursor = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith('<![CDATA[', openIndex)) {
            const end = text.indexOf(']]>', openIndex + 9);
            cursor = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith('<?', openIndex)) {
            const end = text.indexOf('?>', openIndex + 2);
            cursor = end < 0 ? text.length : end + 2;
            continue;
        }

        const closing = text.startsWith('</', openIndex);
        if (text.startsWith('<!', openIndex) && !closing) {
            const end = text.indexOf('>', openIndex + 2);
            cursor = end < 0 ? text.length : end + 1;
            continue;
        }

        let nameIndex = openIndex + (closing ? 2 : 1);
        while (/\s/u.test(text[nameIndex] || '')) nameIndex += 1;
        const nameMatch = text.slice(nameIndex).match(/^[A-Za-z_][\w.:-]*/u);
        if (!nameMatch) {
            cursor = openIndex + 1;
            continue;
        }

        let endIndex = nameIndex + nameMatch[0].length;
        let quote = '';
        while (endIndex < text.length) {
            const character = text[endIndex];
            if (quote) {
                if (character === quote) quote = '';
            } else if (character === '"' || character === "'") {
                quote = character;
            } else if (character === '>') {
                break;
            }
            endIndex += 1;
        }

        if (closing) depth = Math.max(0, depth - 1);
        const beforeClose = text.slice(nameIndex + nameMatch[0].length, endIndex).trimEnd();
        const selfClosing = !closing && beforeClose.endsWith('/');
        tags.push({
            name: nameMatch[0],
            index: openIndex,
            nameIndex,
            length: nameMatch[0].length,
            end: Math.min(endIndex + 1, text.length),
            depth,
            closing,
            selfClosing
        });
        if (!closing && !selfClosing) depth += 1;
        cursor = endIndex < text.length ? endIndex + 1 : text.length;
    }

    return tags;
};

const isElementKey = key => key !== ':@' && !key.startsWith('#') && !key.startsWith('?');

const elementNameOf = entry => (entry && typeof entry === 'object' ? Object.keys(entry).find(isElementKey) || '' : '');

const localNameOf = qualifiedName =>
    String(qualifiedName || '')
        .split(':')
        .pop();

const attributesOf = entry => (entry && typeof entry === 'object' ? entry[':@'] || {} : {});

const elementChildrenOf = (entry, name) => {
    const children = entry && typeof entry === 'object' ? entry[name] : [];
    return Array.isArray(children) ? children.filter(child => elementNameOf(child)) : [];
};

const elementTextOf = (entry, name) => {
    const children = entry && typeof entry === 'object' ? entry[name] : [];
    if (!Array.isArray(children)) return '';
    return children
        .filter(child => Object.prototype.hasOwnProperty.call(child || {}, '#text'))
        .map(child => String(child['#text'] ?? ''))
        .join('')
        .trim();
};

const namespaceForElement = (name, entry, inheritedAttributes = {}) => {
    const prefix = prefixOf(name);
    const namespaceName = prefix ? `xmlns:${prefix}` : 'xmlns';
    const attributes = attributesOf(entry);
    return attributes[`@_${namespaceName}`] || inheritedAttributes[`@_${namespaceName}`] || '';
};

const prefixOf = qualifiedName => {
    const parts = String(qualifiedName || '').split(':');
    return parts.length > 1 ? parts.slice(0, -1).join(':') : '';
};

const attributeNameLocation = (value, tag, attributeName) => {
    if (!tag) return null;
    const openingTag = String(value ?? '').slice(tag.index, tag.end);
    const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = openingTag.match(new RegExp(`(?:^|\\s)(${escapedName})\\s*=`, 'u'));
    if (!match) return null;
    const relativeIndex = match.index + match[0].indexOf(match[1]);
    return {
        index: tag.index + relativeIndex,
        length: match[1].length
    };
};

const pushMatches = (diagnostics, value, pattern, message) => {
    for (const match of String(value ?? '').matchAll(pattern)) {
        diagnostics.push(diagnosticAt(value, message, match.index, match[0].length));
    }
};

const resultFrom = (diagnostics, operation = '') => ({
    valid: diagnostics.length === 0,
    diagnostics: diagnostics.sort((left, right) => left.index - right.index),
    operation
});

const validateCreateSubscription = ({ text, rootAttributes, operationEntry, operationName, tags, diagnostics }) => {
    const operationTag = tags.find(tag => !tag.closing && tag.depth === 1);
    const operationNamespace = namespaceForElement(operationName, operationEntry, rootAttributes);
    if (operationNamespace !== NETCONF_NOTIFICATION_NAMESPACE) {
        diagnostics.push(
            diagnosticAt(
                text,
                `create-subscription 必须使用 RFC 5277 命名空间 ${NETCONF_NOTIFICATION_NAMESPACE}`,
                operationTag?.nameIndex ?? 0,
                operationTag?.length ?? 1
            )
        );
    }

    const children = elementChildrenOf(operationEntry, operationName);
    const allowedOrder = ['stream', 'filter', 'startTime', 'stopTime'];
    const seen = new Map();
    let previousOrder = -1;
    children.forEach((child, index) => {
        const childName = elementNameOf(child);
        const localName = localNameOf(childName);
        const childTag = tags.filter(tag => !tag.closing && tag.depth === 2)[index];
        const order = allowedOrder.indexOf(localName);
        if (order < 0) {
            diagnostics.push(
                diagnosticAt(
                    text,
                    `create-subscription 不支持子元素 ${localName || childName}`,
                    childTag?.nameIndex ?? operationTag?.nameIndex ?? 0,
                    childTag?.length ?? operationTag?.length ?? 1
                )
            );
            return;
        }
        const count = (seen.get(localName) || 0) + 1;
        seen.set(localName, count);
        if (count > 1) {
            diagnostics.push(
                diagnosticAt(
                    text,
                    `${localName} 在 create-subscription 中只能出现一次`,
                    childTag?.nameIndex ?? operationTag?.nameIndex ?? 0,
                    childTag?.length ?? operationTag?.length ?? 1
                )
            );
        }
        if (order < previousOrder) {
            diagnostics.push(
                diagnosticAt(
                    text,
                    `${localName} 的顺序不符合 RFC 5277（stream、filter、startTime、stopTime）`,
                    childTag?.nameIndex ?? operationTag?.nameIndex ?? 0,
                    childTag?.length ?? operationTag?.length ?? 1
                )
            );
        }
        previousOrder = Math.max(previousOrder, order);
    });

    const childByName = localName => children.find(child => localNameOf(elementNameOf(child)) === localName) || null;
    const streamEntry = childByName('stream');
    if (streamEntry && !elementTextOf(streamEntry, elementNameOf(streamEntry))) {
        const streamTag = tags.find(tag => !tag.closing && tag.depth === 2 && localNameOf(tag.name) === 'stream');
        diagnostics.push(
            diagnosticAt(
                text,
                'stream 不能为空',
                streamTag?.nameIndex ?? operationTag?.nameIndex ?? 0,
                streamTag?.length ?? 1
            )
        );
    }

    const filterEntry = childByName('filter');
    if (filterEntry) {
        const filterName = elementNameOf(filterEntry);
        const filterAttributes = attributesOf(filterEntry);
        const filterType = String(filterAttributes['@_type'] || filterAttributes['@_nc:type'] || '').trim();
        const select = String(filterAttributes['@_select'] || filterAttributes['@_nc:select'] || '').trim();
        const filterTag = tags.find(tag => !tag.closing && tag.depth === 2 && localNameOf(tag.name) === 'filter');
        if (filterType && !['subtree', 'xpath'].includes(filterType)) {
            diagnostics.push(
                diagnosticAt(
                    text,
                    'filter type 只能是 subtree 或 xpath',
                    filterTag?.nameIndex ?? operationTag?.nameIndex ?? 0,
                    filterTag?.length ?? 1
                )
            );
        }
        if (filterType === 'xpath' && !select) {
            diagnostics.push(
                diagnosticAt(
                    text,
                    'XPath filter 必须包含非空 select 属性',
                    filterTag?.nameIndex ?? operationTag?.nameIndex ?? 0,
                    filterTag?.length ?? 1
                )
            );
        }
        if (filterType === 'xpath' && elementChildrenOf(filterEntry, filterName).length) {
            diagnostics.push(
                diagnosticAt(
                    text,
                    'XPath filter 不能同时包含 subtree 子元素',
                    filterTag?.nameIndex ?? operationTag?.nameIndex ?? 0,
                    filterTag?.length ?? 1
                )
            );
        }
    }

    const dateValue = name => {
        const entry = childByName(name);
        return entry ? elementTextOf(entry, elementNameOf(entry)) : '';
    };
    const startTime = dateValue('startTime');
    const stopTime = dateValue('stopTime');
    const timeDiagnostic = (name, message) => {
        const tag = tags.find(tag => !tag.closing && tag.depth === 2 && localNameOf(tag.name) === name);
        diagnostics.push(diagnosticAt(text, message, tag?.nameIndex ?? operationTag?.nameIndex ?? 0, tag?.length ?? 1));
    };
    if (seen.has('startTime') && !isRfc3339DateTime(startTime)) {
        timeDiagnostic('startTime', 'startTime 必须是合法 RFC 3339 时间');
    }
    if (seen.has('stopTime') && !isRfc3339DateTime(stopTime)) {
        timeDiagnostic('stopTime', 'stopTime 必须是合法 RFC 3339 时间');
    }
    if (stopTime && !startTime) timeDiagnostic('stopTime', 'stopTime 必须与 startTime 一起使用');
    if (isRfc3339DateTime(startTime) && isRfc3339DateTime(stopTime)) {
        if (rfc3339Timestamp(stopTime) <= rfc3339Timestamp(startTime)) {
            timeDiagnostic('stopTime', 'stopTime 必须晚于 startTime');
        }
    }
};

const modernChildDescriptor = (child, rootAttributes) => {
    const name = elementNameOf(child);
    return {
        entry: child,
        name,
        localName: localNameOf(name),
        namespace: namespaceForElement(name, child, rootAttributes),
        text: elementTextOf(child, name)
    };
};

const uint32Value = value => {
    const text = String(value || '').trim();
    if (!/^\d+$/u.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number >= 0 && number <= 4_294_967_295 ? number : null;
};

const validateModernSubscription = ({
    text,
    rootAttributes,
    operationEntry,
    operationName,
    operation,
    tags,
    diagnostics
}) => {
    const operationTag = tags.find(tag => !tag.closing && tag.depth === 1);
    const expectedNamespace =
        operation === 'resync-subscription' ? YANG_PUSH_NAMESPACE : SUBSCRIBED_NOTIFICATIONS_NAMESPACE;
    const operationNamespace = namespaceForElement(operationName, operationEntry, rootAttributes);
    if (operationNamespace !== expectedNamespace) {
        diagnostics.push(
            diagnosticAt(
                text,
                `${operation} 必须使用命名空间 ${expectedNamespace}`,
                operationTag?.nameIndex ?? 0,
                operationTag?.length ?? 1
            )
        );
    }

    const operationAttributes = { ...rootAttributes, ...attributesOf(operationEntry) };
    const rawChildren = elementChildrenOf(operationEntry, operationName);
    const children = rawChildren.map(child => modernChildDescriptor(child, operationAttributes));
    const childTags = tags.filter(tag => !tag.closing && tag.depth === 2);
    const tagFor = (descriptor, occurrence = 0) => {
        const exactIndex = children.indexOf(descriptor);
        if (exactIndex >= 0) return childTags[exactIndex] || operationTag;
        const indexes = children
            .map((child, index) => ({ child, index }))
            .filter(
                item => item.child.localName === descriptor.localName && item.child.namespace === descriptor.namespace
            );
        return childTags[indexes[occurrence]?.index] || operationTag;
    };
    const report = (descriptor, message, occurrence = 0) => {
        const tag = descriptor ? tagFor(descriptor, occurrence) : operationTag;
        diagnostics.push(diagnosticAt(text, message, tag?.nameIndex ?? 0, tag?.length ?? 1));
    };
    const byName = (localName, namespace) =>
        children.filter(child => child.localName === localName && (!namespace || child.namespace === namespace));
    const one = (localName, namespace) => byName(localName, namespace)[0] || null;
    const ensureUnique = names => {
        names.forEach(([localName, namespace]) => {
            const matches = byName(localName, namespace);
            matches
                .slice(1)
                .forEach((child, index) => report(child, `${localName} 在 ${operation} 中只能出现一次`, index + 1));
        });
    };
    const scalarLeafNames = new Set([
        'id',
        'stream-filter-name',
        'stream-xpath-filter',
        'stream',
        'replay-start-time',
        'stop-time',
        'dscp',
        'weighting',
        'dependency',
        'encoding',
        'datastore',
        'selection-filter-ref',
        'datastore-xpath-filter'
    ]);
    const nonEmptyScalarNames = new Set([
        'stream-filter-name',
        'stream-xpath-filter',
        'stream',
        'encoding',
        'datastore',
        'selection-filter-ref',
        'datastore-xpath-filter'
    ]);
    children.forEach(child => {
        if (!scalarLeafNames.has(child.localName)) return;
        if (elementChildrenOf(child.entry, child.name).length) {
            report(child, `${child.localName} 是标量叶子，不能包含子元素`);
        }
        if (nonEmptyScalarNames.has(child.localName) && !child.text) {
            report(child, `${child.localName} 不能为空`);
        }
    });

    const id = one('id', expectedNamespace);
    if (operation === 'establish-subscription') {
        if (id) report(id, 'establish-subscription 输入不允许包含 id；订阅 id 只会出现在成功输出中');
    } else {
        if (!id) report(null, `${operation} 必须包含 id`);
        else {
            const parsedId = uint32Value(id.text);
            if (parsedId === null) report(id, 'id 必须是 0 到 4294967295 的订阅标识');
            if (children[0] !== id) report(id, `id 必须是 ${operation} 的第一个子元素`);
        }
    }

    if (['delete-subscription', 'kill-subscription', 'resync-subscription'].includes(operation)) {
        children.forEach(child => {
            if (child !== id) report(child, `${operation} 只允许包含 id`);
        });
        ensureUnique([['id', expectedNamespace]]);
        return;
    }

    const snNames = new Set([
        'id',
        'stream-filter-name',
        'stream-subtree-filter',
        'stream-xpath-filter',
        'stream',
        'replay-start-time',
        'stop-time',
        'dscp',
        'weighting',
        'dependency',
        'encoding'
    ]);
    const ypNames = new Set([
        'datastore',
        'selection-filter-ref',
        'datastore-subtree-filter',
        'datastore-xpath-filter',
        'periodic',
        'on-change'
    ]);
    children.forEach(child => {
        const allowed =
            (child.namespace === SUBSCRIBED_NOTIFICATIONS_NAMESPACE && snNames.has(child.localName)) ||
            (child.namespace === YANG_PUSH_NAMESPACE && ypNames.has(child.localName));
        if (!allowed) report(child, `${operation} 不支持子元素 ${child.localName || child.name} 或其命名空间`);
    });
    ensureUnique([
        ['id', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['stream', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['replay-start-time', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['stop-time', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['dscp', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['weighting', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['dependency', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['encoding', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['stream-filter-name', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['stream-subtree-filter', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['stream-xpath-filter', SUBSCRIBED_NOTIFICATIONS_NAMESPACE],
        ['selection-filter-ref', YANG_PUSH_NAMESPACE],
        ['datastore-subtree-filter', YANG_PUSH_NAMESPACE],
        ['datastore-xpath-filter', YANG_PUSH_NAMESPACE],
        ['datastore', YANG_PUSH_NAMESPACE],
        ['periodic', YANG_PUSH_NAMESPACE],
        ['on-change', YANG_PUSH_NAMESPACE]
    ]);

    const stream = one('stream', SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
    const datastore = one('datastore', YANG_PUSH_NAMESPACE);
    const streamFilters = [
        one('stream-filter-name', SUBSCRIBED_NOTIFICATIONS_NAMESPACE),
        one('stream-subtree-filter', SUBSCRIBED_NOTIFICATIONS_NAMESPACE),
        one('stream-xpath-filter', SUBSCRIBED_NOTIFICATIONS_NAMESPACE)
    ].filter(Boolean);
    const datastoreFilters = [
        one('selection-filter-ref', YANG_PUSH_NAMESPACE),
        one('datastore-subtree-filter', YANG_PUSH_NAMESPACE),
        one('datastore-xpath-filter', YANG_PUSH_NAMESPACE)
    ].filter(Boolean);
    const periodic = one('periodic', YANG_PUSH_NAMESPACE);
    const onChange = one('on-change', YANG_PUSH_NAMESPACE);
    const replayInput = one('replay-start-time', SUBSCRIBED_NOTIFICATIONS_NAMESPACE);

    if (operation === 'establish-subscription') {
        if (Boolean(stream) === Boolean(datastore)) {
            report(null, 'establish-subscription 必须且只能选择 stream 或 datastore 目标');
        }
        if (stream && !stream.text) report(stream, 'stream 不能为空');
    } else {
        if (stream) report(stream, 'modify-subscription 不能修改 stream');
        if (Boolean(streamFilters.length) === Boolean(datastore)) {
            report(null, 'modify-subscription 必须包含 stream filter 或 datastore 目标');
        }
    }
    if (streamFilters.length > 1) report(streamFilters[1], 'event stream 过滤器只能选择一种');
    if (datastoreFilters.length > 1) report(datastoreFilters[1], 'datastore 过滤器只能选择一种');
    if (
        (stream || streamFilters.length || replayInput) &&
        (datastore || datastoreFilters.length || periodic || onChange)
    ) {
        report(datastore || datastoreFilters[0] || periodic || onChange, 'event stream 与 YANG-Push 参数不能混用');
    }
    if (datastore && !datastore.text) report(datastore, 'datastore 不能为空');
    if (datastore) {
        const identity = /^([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)$/u.exec(datastore.text);
        if (!identity) {
            report(datastore, 'datastore 必须使用带命名空间前缀的 identityref，例如 ds:operational');
        } else {
            const namespace =
                attributesOf(datastore.entry)[`@_xmlns:${identity[1]}`] ||
                operationAttributes[`@_xmlns:${identity[1]}`];
            if (!namespace) {
                report(datastore, `datastore identity 前缀 ${identity[1]} 缺少 XML 命名空间绑定`);
            } else if (identity[1] === 'ds' && namespace !== IETF_DATASTORES_NAMESPACE) {
                report(datastore, `ds 前缀必须绑定到 ${IETF_DATASTORES_NAMESPACE}`);
            }
        }
    }
    const encoding = one('encoding', SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
    if (encoding?.text) {
        const identity = /^(?:([A-Za-z_][\w.-]*):)?([A-Za-z_][\w.-]*)$/u.exec(encoding.text);
        if (!identity) {
            report(encoding, 'encoding 必须是合法的 identityref QName');
        } else {
            const namespace =
                identity[1] === undefined
                    ? SUBSCRIBED_NOTIFICATIONS_NAMESPACE
                    : attributesOf(encoding.entry)[`@_xmlns:${identity[1]}`] ||
                      operationAttributes[`@_xmlns:${identity[1]}`];
            if (!namespace) {
                report(encoding, `encoding identity 前缀 ${identity[1]} 缺少 XML 命名空间绑定`);
            } else if (
                namespace === SUBSCRIBED_NOTIFICATIONS_NAMESPACE &&
                !['encode-xml', 'encode-json'].includes(identity[2])
            ) {
                report(encoding, `ietf-subscribed-notifications 未定义 encoding identity ${identity[2]}`);
            }
        }
    }
    if (datastore && periodic && onChange) {
        report(onChange, 'YANG-Push 不能同时包含 periodic 和 on-change 更新策略');
    }
    if (operation === 'modify-subscription') {
        ['replay-start-time', 'dscp', 'weighting', 'dependency', 'encoding'].forEach(localName => {
            const child = one(localName, SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
            if (child) report(child, `modify-subscription 不能修改 ${localName}`);
        });
    }

    const validateUnsigned = (localName, maximum, rangeLabel) => {
        const child = one(localName, SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
        const parsed = child ? uint32Value(child.text) : null;
        if (child && (parsed === null || parsed > maximum)) {
            report(child, `${localName} 必须是 ${rangeLabel} 的无符号整数`);
        }
    };
    validateUnsigned('dscp', 63, '0 到 63');
    validateUnsigned('weighting', 255, '0 到 255');
    validateUnsigned('dependency', 4_294_967_295, '0 到 4294967295');

    const validateTime = (localName, namespace) => {
        const child = one(localName, namespace);
        if (child && !isRfc3339DateTime(child.text)) report(child, `${localName} 必须是合法 RFC 3339 时间`);
        return child;
    };
    const replay = validateTime('replay-start-time', SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
    const stop = validateTime('stop-time', SUBSCRIBED_NOTIFICATIONS_NAMESPACE);
    if (replay && isRfc3339DateTime(replay.text) && rfc3339Timestamp(replay.text) >= Date.now()) {
        report(replay, 'replay-start-time 必须早于当前时间');
    }
    if (stop && isRfc3339DateTime(stop.text)) {
        if (replay && isRfc3339DateTime(replay.text) && rfc3339Timestamp(stop.text) <= rfc3339Timestamp(replay.text)) {
            report(stop, 'stop-time 必须晚于 replay-start-time');
        } else if (!replay && rfc3339Timestamp(stop.text) <= Date.now()) {
            report(stop, 'stop-time 必须晚于当前时间');
        }
    }

    const validateTrigger = (trigger, kind) => {
        if (!trigger) return;
        const triggerAttributes = { ...operationAttributes, ...attributesOf(trigger.entry) };
        const triggerChildren = elementChildrenOf(trigger.entry, trigger.name).map(child =>
            modernChildDescriptor(child, triggerAttributes)
        );
        const childByName = localName => triggerChildren.filter(child => child.localName === localName);
        const triggerTag = tagFor(trigger);
        const triggerClosingTag = tags.find(
            tag =>
                tag.closing && tag.depth === 2 && tag.name === triggerTag?.name && tag.index > (triggerTag?.index ?? -1)
        );
        const nestedTags = tags.filter(
            tag =>
                !tag.closing &&
                tag.depth === 3 &&
                tag.index > (triggerTag?.index ?? -1) &&
                tag.index < (triggerClosingTag?.index ?? Number.POSITIVE_INFINITY)
        );
        const triggerReport = (child, message) => {
            const index = child ? triggerChildren.indexOf(child) : -1;
            const tag = index >= 0 ? nestedTags[index] : triggerTag;
            diagnostics.push(diagnosticAt(text, message, tag?.nameIndex ?? 0, tag?.length ?? 1));
        };
        const ensureTriggerUnique = localName => {
            childByName(localName)
                .slice(1)
                .forEach(child => triggerReport(child, `${localName} 在 ${kind} 中只能出现一次`));
        };
        const allowed =
            kind === 'periodic'
                ? new Set(['period', 'anchor-time'])
                : new Set(['dampening-period', 'sync-on-start', 'excluded-change']);
        triggerChildren.forEach(child => {
            if (child.namespace !== YANG_PUSH_NAMESPACE || !allowed.has(child.localName)) {
                triggerReport(child, `${kind} 不支持子元素 ${child.localName || child.name}`);
            } else if (elementChildrenOf(child.entry, child.name).length) {
                triggerReport(child, `${child.localName} 是标量叶子，不能包含子元素`);
            }
        });
        if (kind === 'periodic') {
            ensureTriggerUnique('period');
            ensureTriggerUnique('anchor-time');
            const period = childByName('period')[0];
            if (!period) triggerReport(null, 'periodic 必须包含 period');
            else if (uint32Value(period.text) === null) {
                triggerReport(period, 'period 必须是 0 到 4294967295 的 centiseconds 值');
            }
            const anchor = childByName('anchor-time')[0];
            if (anchor && !isRfc3339DateTime(anchor.text)) {
                triggerReport(anchor, 'anchor-time 必须是合法 RFC 3339 时间');
            }
        } else {
            ensureTriggerUnique('dampening-period');
            ensureTriggerUnique('sync-on-start');
            const dampening = childByName('dampening-period')[0];
            if (dampening && uint32Value(dampening.text) === null) {
                triggerReport(dampening, 'dampening-period 必须是 0 到 4294967295 的 centiseconds 值');
            }
            const sync = childByName('sync-on-start')[0];
            if (sync && !['true', 'false'].includes(sync.text)) {
                triggerReport(sync, 'sync-on-start 必须是 true 或 false');
            }
            childByName('excluded-change').forEach(change => {
                if (!['create', 'delete', 'insert', 'move', 'replace'].includes(change.text)) {
                    triggerReport(change, 'excluded-change 只能是 create、delete、insert、move 或 replace');
                }
                if (operation === 'modify-subscription') {
                    triggerReport(change, 'modify-subscription 不能修改 excluded-change');
                }
            });
            if (operation === 'modify-subscription' && sync) {
                triggerReport(sync, 'modify-subscription 不能修改 sync-on-start');
            }
        }
    };
    validateTrigger(periodic, 'periodic');
    validateTrigger(onChange, 'on-change');
};

/**
 * Validate an editable NETCONF RPC envelope before it is sent to a device.
 * Diagnostic offsets are zero-based; line and column numbers are one-based.
 */
export const validateNetconfRpc = value => {
    const text = String(value ?? '');
    const diagnostics = [];

    if (!text.trim()) {
        diagnostics.push(diagnosticAt(text, 'RPC 报文不能为空', 0, 0));
        return resultFrom(diagnostics);
    }

    pushMatches(diagnostics, text, /<!\s*(?:DOCTYPE|ENTITY)\b/giu, 'RPC 报文不允许包含 DOCTYPE 或 ENTITY 声明');
    pushMatches(diagnostics, text, /NETNEXUS_REQUIRED/gu, '请补全或移除 NETNEXUS_REQUIRED 参数占位');

    // Do not pass declarations that can define entities into an XML parser.
    if (diagnostics.some(item => /DOCTYPE|ENTITY/u.test(item.message))) {
        return resultFrom(diagnostics);
    }

    const validation = XMLValidator.validate(text, { allowBooleanAttributes: false });
    if (validation !== true) {
        const error = validation?.err || {};
        const index = indexAt(text, error.line, error.col);
        diagnostics.push(
            diagnosticAt(text, `XML 格式不合法：${error.msg || '无法解析报文'}`, index, index < text.length ? 1 : 0)
        );
        return resultFrom(diagnostics);
    }

    let parsed;
    try {
        parsed = new XMLParser(XML_PARSE_OPTIONS).parse(text);
    } catch (error) {
        diagnostics.push(diagnosticAt(text, `XML 格式不合法：${error.message || '无法解析报文'}`, 0, 1));
        return resultFrom(diagnostics);
    }

    const tags = scanXmlTags(text);
    const rootTags = tags.filter(tag => !tag.closing && tag.depth === 0);
    const topLevelElements = Array.isArray(parsed) ? parsed.filter(entry => elementNameOf(entry)) : [];
    if (topLevelElements.length !== 1 || rootTags.length !== 1) {
        const invalidRoot = rootTags[1] || rootTags[0];
        diagnostics.push(
            diagnosticAt(
                text,
                'RPC 报文必须且只能包含一个根元素',
                invalidRoot?.nameIndex ?? 0,
                invalidRoot?.length ?? 1
            )
        );
        return resultFrom(diagnostics);
    }

    const rootEntry = topLevelElements[0];
    const rootName = elementNameOf(rootEntry);
    const rootTag = rootTags[0];
    const rootAttributes = rootEntry[':@'] || {};
    const rootLocalName = localNameOf(rootName);
    const rootPrefix = prefixOf(rootName);
    const namespaceAttribute = rootPrefix ? `xmlns:${rootPrefix}` : 'xmlns';
    const rootNamespace = rootAttributes[`@_${namespaceAttribute}`];

    if (rootLocalName !== 'rpc') {
        diagnostics.push(diagnosticAt(text, '根元素必须是 rpc', rootTag.nameIndex, rootTag.length));
    }

    if (rootNamespace !== NETCONF_BASE_NAMESPACE) {
        const attributeLocation = attributeNameLocation(text, rootTag, namespaceAttribute);
        diagnostics.push(
            diagnosticAt(
                text,
                `rpc 根元素必须使用 NETCONF base 命名空间 ${NETCONF_BASE_NAMESPACE}`,
                attributeLocation?.index ?? rootTag.nameIndex,
                attributeLocation?.length ?? rootTag.length
            )
        );
    }

    const messageId = rootAttributes['@_message-id'];
    if (messageId === undefined || !String(messageId).trim()) {
        const attributeLocation = attributeNameLocation(text, rootTag, 'message-id');
        diagnostics.push(
            diagnosticAt(
                text,
                'rpc 根元素缺少非空的 message-id 属性',
                attributeLocation?.index ?? rootTag.nameIndex,
                attributeLocation?.length ?? rootTag.length
            )
        );
    }

    const rootChildren = Array.isArray(rootEntry[rootName]) ? rootEntry[rootName] : [];
    const operationEntries = rootChildren.filter(entry => elementNameOf(entry));
    const operationName = operationEntries.length === 1 ? elementNameOf(operationEntries[0]) : '';
    const operation = localNameOf(operationName);
    const operationTags = tags.filter(tag => !tag.closing && tag.depth === 1);
    const characterData = rootChildren.find(
        entry => Object.prototype.hasOwnProperty.call(entry || {}, '#text') && String(entry['#text']).trim()
    );

    if (operationEntries.length !== 1) {
        const invalidOperation = operationEntries.length > 1 ? operationTags[1] : rootTag;
        diagnostics.push(
            diagnosticAt(
                text,
                'rpc 内必须且只能包含一个操作元素',
                invalidOperation?.nameIndex ?? rootTag.nameIndex,
                invalidOperation?.length ?? rootTag.length
            )
        );
    } else if (characterData) {
        const characterValue = String(characterData['#text']);
        const nonWhitespaceOffset = characterValue.search(/\S/u);
        const characterIndex = text.indexOf(characterValue, rootTag.end);
        diagnostics.push(
            diagnosticAt(
                text,
                'rpc 操作元素之外不能包含文本内容',
                characterIndex >= 0 ? characterIndex + Math.max(0, nonWhitespaceOffset) : rootTag.nameIndex,
                1
            )
        );
    }

    if (operationEntries.length === 1 && operation === 'create-subscription') {
        validateCreateSubscription({
            text,
            rootAttributes,
            operationEntry: operationEntries[0],
            operationName,
            tags,
            diagnostics
        });
    }
    if (
        operationEntries.length === 1 &&
        [
            'establish-subscription',
            'modify-subscription',
            'delete-subscription',
            'kill-subscription',
            'resync-subscription'
        ].includes(operation)
    ) {
        validateModernSubscription({
            text,
            rootAttributes,
            operationEntry: operationEntries[0],
            operationName,
            operation,
            tags,
            diagnostics
        });
    }

    return resultFrom(diagnostics, operation);
};
