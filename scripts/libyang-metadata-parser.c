/* Appended to the pinned libyang parser_yang.c at build time. Keep all lexical
 * and statement parsing in libyang, without loading imports or compiling types.
 * This private adapter is deliberately tied to resources/libyang/manifest.json. */
LY_ERR
netnexus_yang_parse_metadata(struct ly_ctx *ctx, struct ly_in *in, struct lys_module **module)
{
    struct lys_module *mod = NULL;
    struct lysp_yang_ctx *pctx = NULL;
    struct lysp_module *parsed = NULL;
    enum ly_stmt keyword;
    char *word;
    size_t length;
    LY_ERR ret = LY_EMEM;

    *module = NULL;
    mod = calloc(1, sizeof *mod);
    pctx = calloc(1, sizeof *pctx);
    parsed = calloc(1, sizeof *parsed);
    if (!mod || !pctx || !parsed) {
        free(mod);
        free(pctx);
        free(parsed);
        return LY_EMEM;
    }
    mod->ctx = ctx;
    parsed->mod = mod;
    mod->parsed = parsed;
    pctx->format = LYS_IN_YANG;
    pctx->in = in;
    pctx->main_ctx = (struct lysp_ctx *)pctx;
    if (ly_set_new(&pctx->parsed_mods) || ly_set_add(pctx->parsed_mods, parsed, 1, NULL)) {
        ly_set_free(pctx->parsed_mods, NULL);
        free(pctx);
        lys_module_free(ctx, mod, 0);
        return LY_EMEM;
    }

    ly_log_location(NULL, NULL, in);
    ret = skip_redundant_chars(pctx);
    if (!ret) {
        ret = get_keyword(pctx, &keyword, &word, &length);
    }
    if (!ret && (keyword == LY_STMT_SUBMODULE)) {
        struct lysp_submodule *submodule = calloc(1, sizeof *submodule);
        if (!submodule) {
            ret = LY_EMEM;
        } else {
            submodule->mod = mod;
            free(parsed);
            parsed = (struct lysp_module *)submodule;
            mod->parsed = parsed;
            pctx->parsed_mods->objs[0] = parsed;
            ret = parse_submodule(pctx, submodule);
        }
    } else if (!ret && (keyword == LY_STMT_MODULE)) {
        ret = parse_module(pctx, parsed);
    } else if (!ret) {
        LOGVAL_PARSER(pctx, LY_VCODE_MOD_SUBOMD, lyplg_ext_stmt2str(keyword));
        ret = LY_EVALID;
    }
    if (!ret) {
        ret = skip_redundant_chars(pctx);
        if (!ret && in->current[0]) {
            LOGVAL_PARSER(pctx, LY_VCODE_TRAILING_MOD, 15, in->current,
                    strlen(in->current) > 15 ? "..." : "");
            ret = LY_EVALID;
        }
    }
    ly_log_location_revert(0, 0, 1);
    lysp_yang_ctx_free(pctx);
    if (ret) {
        lys_module_free(ctx, mod, 0);
    } else {
        *module = mod;
    }
    return ret;
}
