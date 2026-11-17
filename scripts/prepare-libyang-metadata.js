const fs = require('fs');
const path = require('path');

function prepareLibyangMetadata(sourceDirectory) {
    const parserPath = path.join(sourceDirectory, 'src', 'parser_yang.c');
    let source = fs.readFileSync(parserPath, 'utf8');
    if (source.includes('netnexus_yang_parse_metadata(')) return;
    const expected = '    if (ly_strncmp(PARSER_CUR_PMOD(ctx)->mod->name, word, word_len)) {';
    if (source.split(expected).length !== 2) throw new Error('Pinned libyang belongs-to parser changed');
    source = source.replace(
        expected,
        // Normal libyang loads always have a parent name. The metadata adapter
        // starts with an unnamed parent and records belongs-to using libyang's lexer.
        '    if (!PARSER_CUR_PMOD(ctx)->mod->name) {\n' +
            '        ret = lysdict_insert(PARSER_CTX(ctx), word, word_len, &submod->mod->name);\n' +
            '        if (ret) { free(buf); return ret; }\n' +
            '    }\n' +
            expected
    );
    source += '\n' + fs.readFileSync(path.join(__dirname, 'libyang-metadata-parser.c'), 'utf8');
    fs.writeFileSync(parserPath, source);
}

if (require.main === module) prepareLibyangMetadata(process.argv[2]);
module.exports = { prepareLibyangMetadata };
