const { BGP_AS_PATH_TYPE: TYPE } = require('../../const/bgpConst');

function formatAsPath(segments) {
    return segments
        .map(segment =>
            segment.type === TYPE.AS_SEQUENCE ? segment.asNumbers.join(' ') : `{${segment.asNumbers.join(' ')}}`
        )
        .join(' ');
}

function isConfederation(segment) {
    return segment.type === TYPE.AS_CONFED_SEQUENCE || segment.type === TYPE.AS_CONFED_SET;
}

function pathLength(segments) {
    return segments.reduce(
        (length, segment) =>
            length + (isConfederation(segment) ? 0 : segment.type === TYPE.AS_SET ? 1 : segment.asNumbers.length),
        0
    );
}

// RFC 6793 sections 4.2.3 and 6: AS_SET counts as one, confederation
// segments do not count, and AS4_PATH replaces the matching trailing length.
function reconstructLegacyAsPath(asPath, rawAs4Path) {
    const as4Path = rawAs4Path.filter(segment => !isConfederation(segment));
    let remaining = pathLength(asPath) - pathLength(as4Path);
    if (remaining < 0 || as4Path.length === 0) return asPath;

    const prefix = [];
    for (const segment of asPath) {
        if (isConfederation(segment)) {
            prefix.push(segment);
            continue;
        }
        if (remaining === 0) break;
        if (segment.type === TYPE.AS_SET) {
            prefix.push(segment);
            remaining -= 1;
        } else {
            const count = Math.min(remaining, segment.asNumbers.length);
            prefix.push(
                count === segment.asNumbers.length
                    ? segment
                    : { ...segment, asNumbers: segment.asNumbers.slice(0, count) }
            );
            remaining -= count;
            if (count < segment.asNumbers.length) break;
        }
    }
    return prefix.concat(as4Path);
}

module.exports = { formatAsPath, reconstructLegacyAsPath };
