/*
 * NetNexus authoritative YANG schema exporter.
 *
 * This program intentionally has no fallback parser.  It loads, compiles, and
 * traverses the effective schema exclusively through the bundled libyang API.
 */

#include <libyang/libyang.h>
#include <libyang/version.h>

#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <locale.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT_SCHEMA_VERSION 2
#define ROOT_NODE_ID "yang-schema-root"
#define MAX_EXPORT_NODES ((size_t)100000)
#define MAX_EXPORT_DEPTH ((size_t)256)
#define MAX_JSON_ALLOCATION_BYTES ((size_t)64 * 1024 * 1024)
#define MAX_JSON_BYTES (MAX_JSON_ALLOCATION_BYTES - 1)
#define MAX_SCHEMA_LIST_BYTES ((size_t)64 * 1024 * 1024)
#ifdef _WIN32
#define SEARCH_PATH_SEPARATOR ';'
#else
#define SEARCH_PATH_SEPARATOR ':'
#endif

struct string_list {
    char **items;
    size_t count;
    size_t capacity;
};

struct feature_spec {
    char *module;
    struct string_list features;
    int applied;
};

struct feature_specs {
    struct feature_spec *items;
    size_t count;
    size_t capacity;
};

struct module_list {
    struct lys_module **items;
    size_t count;
    size_t capacity;
};

struct export_node {
    const struct lys_module *module_root;
    const struct lysc_node *schema;
    char *id;
    char *parent_id;
    char *path;
    size_t *children;
    size_t child_count;
    size_t child_capacity;
};

struct export_tree {
    struct export_node *nodes;
    size_t count;
    size_t capacity;
    size_t *roots;
    size_t root_count;
    size_t root_capacity;
};

struct json_buffer {
    char *data;
    size_t length;
    size_t capacity;
    int failed;
};

static char *
copy_string(const char *value)
{
    size_t length;
    char *copy;

    if (!value) {
        return NULL;
    }
    length = strlen(value);
    copy = malloc(length + 1);
    if (copy) {
        memcpy(copy, value, length + 1);
    }
    return copy;
}

static int
grow_array(void **array, size_t *capacity, size_t item_size, size_t required)
{
    size_t next;
    void *resized;

    if (*capacity >= required) {
        return 0;
    }
    next = *capacity ? *capacity : 8;
    while (next < required) {
        if (next > SIZE_MAX / 2) {
            return -1;
        }
        next *= 2;
    }
    if (item_size && (next > SIZE_MAX / item_size)) {
        return -1;
    }
    resized = realloc(*array, next * item_size);
    if (!resized) {
        return -1;
    }
    *array = resized;
    *capacity = next;
    return 0;
}

static int
string_list_add(struct string_list *list, const char *value, int unique)
{
    size_t index;
    char *copy;

    if (unique) {
        for (index = 0; index < list->count; ++index) {
            if (!strcmp(list->items[index], value)) {
                return 0;
            }
        }
    }
    if (grow_array((void **)&list->items, &list->capacity, sizeof *list->items, list->count + 1)) {
        return -1;
    }
    copy = copy_string(value);
    if (!copy) {
        return -1;
    }
    list->items[list->count++] = copy;
    return 0;
}

static void
string_list_erase(struct string_list *list)
{
    size_t index;

    for (index = 0; index < list->count; ++index) {
        free(list->items[index]);
    }
    free(list->items);
    memset(list, 0, sizeof *list);
}

static int
load_schema_path_list(const char *path, struct string_list *schema_paths)
{
    FILE *stream = NULL;
    char *buffer = NULL, *cursor, *terminator, *end;
    long file_length;
    size_t length;
    int result = -1;

    stream = fopen(path, "rb");
    if (!stream) {
        fprintf(stderr, "Unable to open schema path list '%s': %s.\n", path, strerror(errno));
        goto cleanup;
    }
    if (fseek(stream, 0, SEEK_END)) {
        fprintf(stderr, "Unable to determine the size of schema path list '%s'.\n", path);
        goto cleanup;
    }
    file_length = ftell(stream);
    if ((file_length < 0) || fseek(stream, 0, SEEK_SET)) {
        fprintf(stderr, "Unable to determine the size of schema path list '%s'.\n", path);
        goto cleanup;
    }
    length = (size_t)file_length;
    if (!length || (length > MAX_SCHEMA_LIST_BYTES)) {
        fprintf(stderr, "Schema path list '%s' must contain 1 to %" PRIuMAX " bytes.\n", path,
                (uintmax_t)MAX_SCHEMA_LIST_BYTES);
        goto cleanup;
    }
    buffer = malloc(length);
    if (!buffer) {
        fprintf(stderr, "Out of memory while reading schema path list '%s'.\n", path);
        goto cleanup;
    }
    if (fread(buffer, 1, length, stream) != length) {
        fprintf(stderr, "Unable to read schema path list '%s'.\n", path);
        goto cleanup;
    }

    cursor = buffer;
    end = buffer + length;
    while (cursor < end) {
        terminator = memchr(cursor, '\0', (size_t)(end - cursor));
        if (!terminator || (terminator == cursor)) {
            fprintf(stderr, "Schema path list '%s' is not a valid non-empty NUL-separated list.\n", path);
            goto cleanup;
        }
        if (string_list_add(schema_paths, cursor, 1)) {
            fprintf(stderr, "Unable to add an entry from schema path list '%s'.\n", path);
            goto cleanup;
        }
        cursor = terminator + 1;
    }
    result = 0;

cleanup:
    free(buffer);
    if (stream) {
        fclose(stream);
    }
    return result;
}

static struct feature_spec *
feature_specs_find(struct feature_specs *specs, const char *module)
{
    size_t index;

    for (index = 0; index < specs->count; ++index) {
        if (!strcmp(specs->items[index].module, module)) {
            return &specs->items[index];
        }
    }
    return NULL;
}

static int
feature_specs_add(struct feature_specs *specs, const char *argument)
{
    const char *separator;
    struct feature_spec *spec;
    char *module = NULL, *feature_text = NULL, *cursor, *next;
    size_t module_length;

    separator = strchr(argument, ':');
    if (!separator || (separator == argument)) {
        fprintf(stderr, "Invalid feature argument '%s'; expected module:feature1,feature2.\n", argument);
        return -1;
    }
    module_length = (size_t)(separator - argument);
    module = malloc(module_length + 1);
    if (!module) {
        return -1;
    }
    memcpy(module, argument, module_length);
    module[module_length] = '\0';

    spec = feature_specs_find(specs, module);
    if (!spec) {
        if (grow_array((void **)&specs->items, &specs->capacity, sizeof *specs->items, specs->count + 1)) {
            free(module);
            return -1;
        }
        spec = &specs->items[specs->count++];
        memset(spec, 0, sizeof *spec);
        spec->module = module;
        module = NULL;
    }
    free(module);

    feature_text = copy_string(separator + 1);
    if (!feature_text) {
        return -1;
    }
    cursor = feature_text;
    while (*cursor) {
        next = strchr(cursor, ',');
        if (next) {
            *next = '\0';
        }
        if (!*cursor) {
            fprintf(stderr, "Invalid empty feature in '%s'.\n", argument);
            free(feature_text);
            return -1;
        }
        if (string_list_add(&spec->features, cursor, 1)) {
            free(feature_text);
            return -1;
        }
        if (!next) {
            break;
        }
        cursor = next + 1;
    }
    free(feature_text);
    return 0;
}

static void
feature_specs_erase(struct feature_specs *specs)
{
    size_t index;

    for (index = 0; index < specs->count; ++index) {
        free(specs->items[index].module);
        string_list_erase(&specs->items[index].features);
    }
    free(specs->items);
    memset(specs, 0, sizeof *specs);
}

static int
module_list_contains(const struct module_list *list, const struct lys_module *module)
{
    size_t index;

    for (index = 0; index < list->count; ++index) {
        if (list->items[index] == module) {
            return 1;
        }
    }
    return 0;
}

static int
module_list_add(struct module_list *list, struct lys_module *module)
{
    if (!module || module_list_contains(list, module)) {
        return 0;
    }
    if (grow_array((void **)&list->items, &list->capacity, sizeof *list->items, list->count + 1)) {
        return -1;
    }
    list->items[list->count++] = module;
    return 0;
}

static void
module_list_erase(struct module_list *list)
{
    free(list->items);
    memset(list, 0, sizeof *list);
}

static int
module_relation_has_owner(struct lys_module **relation, const struct module_list *modules,
        const struct module_list *deviation_modules)
{
    LY_ARRAY_COUNT_TYPE index;

    LY_ARRAY_FOR(relation, index) {
        if (module_list_contains(modules, relation[index]) ||
                module_list_contains(deviation_modules, relation[index])) {
            return 1;
        }
    }
    return 0;
}

static int
expand_relevant_modules(struct module_list *modules, const struct module_list *deviation_modules,
        struct ly_ctx *context)
{
    struct lys_module *candidate;
    uint32_t context_index;
    int added;

    do {
        added = 0;
        context_index = 0;
        while ((candidate = ly_ctx_get_module_iter(context, &context_index))) {
            if (!candidate->implemented || !candidate->compiled || module_list_contains(modules, candidate) ||
                    module_list_contains(deviation_modules, candidate)) {
                continue;
            }
            if (!module_relation_has_owner(candidate->augmented_by, modules, deviation_modules) &&
                    !module_relation_has_owner(candidate->deviated_by, modules, deviation_modules)) {
                continue;
            }
            if (module_list_add(modules, candidate)) {
                return -1;
            }
            added = 1;
        }
    } while (added);
    return 0;
}

static char *
path_directory(const char *path)
{
    const char *cursor, *separator = NULL;
    size_t length;
    char *directory;

    for (cursor = path; *cursor; ++cursor) {
        if ((*cursor == '/') || (*cursor == '\\')) {
            separator = cursor;
        }
    }
    if (!separator) {
        return copy_string(".");
    }
    length = separator == path ? 1 : (size_t)(separator - path);
#ifdef _WIN32
    if ((separator == path + 2) && (path[1] == ':')) {
        /* Preserve the separator for a file directly below a Windows drive root. */
        length = 3;
    }
#endif
    directory = malloc(length + 1);
    if (!directory) {
        return NULL;
    }
    memcpy(directory, path, length);
    directory[length] = '\0';
    return directory;
}

static char *
join_search_paths(const struct string_list *paths)
{
    size_t index, length = 1, offset = 0, item_length;
    char *joined;

    for (index = 0; index < paths->count; ++index) {
        item_length = strlen(paths->items[index]);
        if (index && (length == SIZE_MAX)) {
            return NULL;
        }
        length += index != 0;
        if (item_length > SIZE_MAX - length) {
            return NULL;
        }
        length += item_length;
    }
    joined = malloc(length);
    if (!joined) {
        return NULL;
    }
    for (index = 0; index < paths->count; ++index) {
        if (index) {
            joined[offset++] = SEARCH_PATH_SEPARATOR;
        }
        item_length = strlen(paths->items[index]);
        memcpy(joined + offset, paths->items[index], item_length);
        offset += item_length;
    }
    joined[offset] = '\0';
    return joined;
}

static const char **
feature_values(const struct feature_spec *spec, int *allocated)
{
    static const char *no_features[] = {NULL};
    const char **result;
    size_t index;

    *allocated = 0;
    if (!spec->features.count) {
        return no_features;
    }
    result = calloc(spec->features.count + 1, sizeof *result);
    if (!result) {
        return NULL;
    }
    for (index = 0; index < spec->features.count; ++index) {
        result[index] = spec->features.items[index];
    }
    *allocated = 1;
    return result;
}

static int
apply_feature_spec(struct feature_specs *specs, struct lys_module *module)
{
    struct feature_spec *spec;
    const char **features;
    int allocated;

    spec = feature_specs_find(specs, module->name);
    if (!spec) {
        return 0;
    }
    features = feature_values(spec, &allocated);
    if (!features) {
        fprintf(stderr, "Out of memory while applying features for module '%s'.\n", spec->module);
        return -1;
    }
    if (lys_set_implemented(module, features) != LY_SUCCESS) {
        fprintf(stderr, "Unable to apply specified features for module '%s'.\n", spec->module);
        if (allocated) {
            free((void *)features);
        }
        return -1;
    }
    if (allocated) {
        free((void *)features);
    }
    spec->applied = 1;
    return 0;
}

static int
apply_remaining_features(struct feature_specs *specs, struct ly_ctx *context)
{
    struct feature_spec *spec;
    struct lys_module *module;
    size_t index;

    for (index = 0; index < specs->count; ++index) {
        spec = &specs->items[index];
        if (spec->applied) {
            continue;
        }
        module = (struct lys_module *)ly_ctx_get_module_implemented(context, spec->module);
        if (!module) {
            module = (struct lys_module *)ly_ctx_get_module_latest(context, spec->module);
        }
        if (!module) {
            fprintf(stderr, "Specified features not applied; module '%s' is not loaded.\n", spec->module);
            return -1;
        }
        if (apply_feature_spec(specs, module)) {
            return -1;
        }
    }
    return 0;
}

static int
parse_schema_file(struct ly_ctx *context, struct feature_specs *specs, const char *path,
        struct lys_module **module)
{
    static const char *all_features[] = {"*", NULL};
    static const char *no_features[] = {NULL};
    struct ly_in *input = NULL;
    const char **features;
    char *directory = NULL;
    LY_ERR result;

    *module = NULL;
    directory = path_directory(path);
    if (!directory) {
        fprintf(stderr, "Out of memory while preparing '%s'.\n", path);
        return -1;
    }
    result = ly_ctx_set_searchdir(context, directory);
    if ((result != LY_SUCCESS) && (result != LY_EEXIST)) {
        fprintf(stderr, "Unable to add schema search directory '%s'.\n", directory);
        free(directory);
        return -1;
    }
    free(directory);

    /* Match yanglint: no -F enables all; once any -F exists, unspecified modules start with all disabled. */
    features = specs->count ? no_features : all_features;
    result = ly_in_new_filepath(path, 0, &input);
    if (result != LY_SUCCESS) {
        fprintf(stderr, "Unable to open YANG schema '%s': %s.\n", path, strerror(errno));
        return -1;
    }
    result = lys_parse(context, input, LYS_IN_UNKNOWN, features, module);
    ly_in_free(input, 1);
    if (result != LY_SUCCESS) {
        fprintf(stderr, "Authoritative libyang compilation failed for '%s'.\n", path);
        return -1;
    }
    if (specs->count && apply_feature_spec(specs, *module)) {
        return -1;
    }
    return 0;
}

static uint64_t
fnv1a(const char *value, uint64_t seed)
{
    const unsigned char *cursor = (const unsigned char *)value;
    uint64_t hash = seed;

    while (*cursor) {
        hash ^= *cursor++;
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

static const char *
schema_keyword(const struct lysc_node *node)
{
    switch (node->nodetype) {
    case LYS_CONTAINER:
        return "container";
    case LYS_LIST:
        return "list";
    case LYS_LEAF:
        return "leaf";
    case LYS_LEAFLIST:
        return "leaf-list";
    case LYS_CHOICE:
        return "choice";
    case LYS_CASE:
        return "case";
    case LYS_ANYXML:
        return "anyxml";
    case LYS_ANYDATA:
        return "anydata";
    case LYS_RPC:
        return "rpc";
    case LYS_ACTION:
        return "action";
    case LYS_NOTIF:
        return "notification";
    case LYS_INPUT:
        return "input";
    case LYS_OUTPUT:
        return "output";
    default:
        return "unknown";
    }
}

static char *
stable_id(const char *prefix, const char *identity)
{
    uint64_t first, second;
    size_t length;
    char *result;

    first = fnv1a(identity, UINT64_C(14695981039346656037));
    second = fnv1a(identity, UINT64_C(7809847782465536322));
    length = strlen(prefix) + 33;
    result = malloc(length);
    if (!result) {
        return NULL;
    }
    snprintf(result, length, "%s%016" PRIx64 "%016" PRIx64, prefix, first, second);
    return result;
}

static char *
module_identity(const struct lys_module *module)
{
    size_t length;
    char *identity;

    length = strlen(module->name) + (module->revision ? strlen(module->revision) : 0) + 2;
    identity = malloc(length);
    if (!identity) {
        return NULL;
    }
    snprintf(identity, length, "%s@%s", module->name, module->revision ? module->revision : "");
    return identity;
}

static char *
schema_identity(const struct lysc_node *node, const char *path)
{
    const char *keyword = schema_keyword(node);
    size_t length;
    char *identity;

    length = strlen(node->module->name) + strlen(path) + strlen(keyword ? keyword : "node") + 3;
    identity = malloc(length);
    if (!identity) {
        return NULL;
    }
    snprintf(identity, length, "%s|%s|%s", node->module->name, keyword ? keyword : "node", path);
    return identity;
}

static int
export_tree_add_child(struct export_node *parent, size_t child)
{
    if (grow_array((void **)&parent->children, &parent->child_capacity, sizeof *parent->children,
            parent->child_count + 1)) {
        return -1;
    }
    parent->children[parent->child_count++] = child;
    return 0;
}

static int
export_tree_add_root(struct export_tree *tree, size_t root)
{
    if (grow_array((void **)&tree->roots, &tree->root_capacity, sizeof *tree->roots, tree->root_count + 1)) {
        return -1;
    }
    tree->roots[tree->root_count++] = root;
    return 0;
}

static int
export_tree_new_node(struct export_tree *tree, struct export_node **node, size_t *index)
{
    if (tree->count >= MAX_EXPORT_NODES) {
        fprintf(stderr, "Schema export exceeded the maxNodes limit of %" PRIuMAX ".\n",
                (uintmax_t)MAX_EXPORT_NODES);
        return -1;
    }
    if (grow_array((void **)&tree->nodes, &tree->capacity, sizeof *tree->nodes, tree->count + 1)) {
        return -1;
    }
    *index = tree->count++;
    *node = &tree->nodes[*index];
    memset(*node, 0, sizeof **node);
    return 0;
}

static int export_schema_node(struct export_tree *tree, const struct lysc_node *schema, size_t parent_index,
        size_t depth);

static int
export_schema_siblings(struct export_tree *tree, const struct lysc_node *first, const struct lysc_node *parent,
        size_t parent_index, size_t depth)
{
    const struct lysc_node *node;

    for (node = first; node && (node->parent == parent); node = node->next) {
        if (export_schema_node(tree, node, parent_index, depth)) {
            return -1;
        }
    }
    return 0;
}

static int
export_schema_node(struct export_tree *tree, const struct lysc_node *schema, size_t parent_index, size_t depth)
{
    struct export_node *node;
    const struct lysc_node_action *action;
    const struct lysc_node_notif *notification;
    char *identity = NULL;
    size_t index;

    if (depth > MAX_EXPORT_DEPTH) {
        fprintf(stderr, "Schema export exceeded the maxDepth limit of %" PRIuMAX " at node '%s'.\n",
                (uintmax_t)MAX_EXPORT_DEPTH, schema->name ? schema->name : "<unknown>");
        return -1;
    }
    if (export_tree_new_node(tree, &node, &index)) {
        return -1;
    }
    node->schema = schema;
    node->parent_id = copy_string(tree->nodes[parent_index].id);
    if (!node->parent_id) {
        return -1;
    }
    node->path = lysc_path(schema, LYSC_PATH_LOG, NULL, 0);
    if (!node->path) {
        return -1;
    }
    identity = schema_identity(schema, node->path);
    if (!identity) {
        return -1;
    }
    node->id = stable_id("yang-node-", identity);
    free(identity);
    if (!node->id || export_tree_add_child(&tree->nodes[parent_index], index)) {
        return -1;
    }

    if (export_schema_siblings(tree, lysc_node_child(schema), schema, index, depth + 1)) {
        return -1;
    }
    for (action = lysc_node_actions(schema); action; action = action->next) {
        if (export_schema_node(tree, &action->node, index, depth + 1)) {
            return -1;
        }
    }
    for (notification = lysc_node_notifs(schema); notification; notification = notification->next) {
        if (export_schema_node(tree, &notification->node, index, depth + 1)) {
            return -1;
        }
    }
    return 0;
}

static int
export_module(struct export_tree *tree, const struct lys_module *module)
{
    struct export_node *root;
    const struct lysc_node *schema;
    const struct lysc_node_action *rpc;
    const struct lysc_node_notif *notification;
    char *identity = NULL;
    size_t index, path_length;

    if (!module->compiled || export_tree_new_node(tree, &root, &index)) {
        return -1;
    }
    root->module_root = module;
    root->parent_id = copy_string(ROOT_NODE_ID);
    identity = module_identity(module);
    if (!identity) {
        return -1;
    }
    root->id = stable_id("yang-module-", identity);
    free(identity);
    path_length = strlen(module->name) + 2;
    root->path = malloc(path_length);
    if (root->path) {
        snprintf(root->path, path_length, "/%s", module->name);
    }
    if (!root->id || !root->parent_id || !root->path || export_tree_add_root(tree, index)) {
        return -1;
    }

    for (schema = module->compiled->data; schema; schema = schema->next) {
        if (export_schema_node(tree, schema, index, 1)) {
            return -1;
        }
    }
    for (rpc = module->compiled->rpcs; rpc; rpc = rpc->next) {
        if (export_schema_node(tree, &rpc->node, index, 1)) {
            return -1;
        }
    }
    for (notification = module->compiled->notifs; notification; notification = notification->next) {
        if (export_schema_node(tree, &notification->node, index, 1)) {
            return -1;
        }
    }
    return 0;
}

static void
export_tree_erase(struct export_tree *tree)
{
    size_t index;

    for (index = 0; index < tree->count; ++index) {
        free(tree->nodes[index].id);
        free(tree->nodes[index].parent_id);
        free(tree->nodes[index].path);
        free(tree->nodes[index].children);
    }
    free(tree->nodes);
    free(tree->roots);
    memset(tree, 0, sizeof *tree);
}

static int
json_reserve(struct json_buffer *buffer, size_t additional)
{
    size_t required, next;
    char *resized;

    if (buffer->failed) {
        return -1;
    }
    if ((buffer->length > MAX_JSON_BYTES) || (additional > MAX_JSON_BYTES - buffer->length)) {
        fprintf(stderr, "Schema export exceeded the maxJsonBytes limit of %" PRIuMAX ".\n",
                (uintmax_t)MAX_JSON_BYTES);
        buffer->failed = 1;
        return -1;
    }
    if (additional > SIZE_MAX - buffer->length - 1) {
        buffer->failed = 1;
        return -1;
    }
    required = buffer->length + additional + 1;
    if (buffer->capacity >= required) {
        return 0;
    }
    next = buffer->capacity ? buffer->capacity : 4096;
    while (next < required) {
        if (next > MAX_JSON_BYTES / 2) {
            next = MAX_JSON_BYTES + 1;
            break;
        }
        next *= 2;
    }
    resized = realloc(buffer->data, next);
    if (!resized) {
        buffer->failed = 1;
        return -1;
    }
    buffer->data = resized;
    buffer->capacity = next;
    return 0;
}

static void
json_raw_n(struct json_buffer *buffer, const char *value, size_t length)
{
    if (json_reserve(buffer, length)) {
        return;
    }
    memcpy(buffer->data + buffer->length, value, length);
    buffer->length += length;
    buffer->data[buffer->length] = '\0';
}

static void
json_raw(struct json_buffer *buffer, const char *value)
{
    json_raw_n(buffer, value, strlen(value));
}

static void
json_string(struct json_buffer *buffer, const char *value)
{
    const unsigned char *cursor;
    char escaped[7];

    if (!value) {
        json_raw(buffer, "null");
        return;
    }
    json_raw(buffer, "\"");
    for (cursor = (const unsigned char *)value; *cursor; ++cursor) {
        switch (*cursor) {
        case '\"':
            json_raw(buffer, "\\\"");
            break;
        case '\\':
            json_raw(buffer, "\\\\");
            break;
        case '\b':
            json_raw(buffer, "\\b");
            break;
        case '\f':
            json_raw(buffer, "\\f");
            break;
        case '\n':
            json_raw(buffer, "\\n");
            break;
        case '\r':
            json_raw(buffer, "\\r");
            break;
        case '\t':
            json_raw(buffer, "\\t");
            break;
        default:
            if (*cursor < 0x20) {
                snprintf(escaped, sizeof escaped, "\\u%04x", *cursor);
                json_raw(buffer, escaped);
            } else {
                json_raw_n(buffer, (const char *)cursor, 1);
            }
        }
    }
    json_raw(buffer, "\"");
}

static void
json_key(struct json_buffer *buffer, const char *key)
{
    json_string(buffer, key);
    json_raw(buffer, ":");
}

static void
json_size(struct json_buffer *buffer, size_t value)
{
    char text[32];
    snprintf(text, sizeof text, "%" PRIuMAX, (uintmax_t)value);
    json_raw(buffer, text);
}

static const char *
schema_status(const struct lysc_node *node)
{
    switch (node->flags & LYS_STATUS_MASK) {
    case LYS_STATUS_DEPRC:
        return "deprecated";
    case LYS_STATUS_OBSLT:
        return "obsolete";
    default:
        return "current";
    }
}

static int
schema_in_operation(const struct lysc_node *node)
{
    const struct lysc_node *cursor;

    for (cursor = node; cursor; cursor = cursor->parent) {
        if (cursor->nodetype & (LYS_RPC | LYS_ACTION | LYS_NOTIF | LYS_INPUT | LYS_OUTPUT)) {
            return 1;
        }
    }
    return 0;
}

static int
schema_has_config(const struct lysc_node *node)
{
    if (schema_in_operation(node)) {
        return 0;
    }
    return !!(node->nodetype &
            (LYS_CONTAINER | LYS_LIST | LYS_LEAF | LYS_LEAFLIST | LYS_CHOICE | LYS_CASE | LYS_ANYXML | LYS_ANYDATA));
}

static int
schema_has_mandatory(const struct lysc_node *node)
{
    return !!(node->nodetype & (LYS_LEAF | LYS_CHOICE | LYS_ANYXML | LYS_ANYDATA));
}

static const struct lysc_type *
schema_type(const struct lysc_node *node)
{
    if (node->nodetype == LYS_LEAF) {
        return ((const struct lysc_node_leaf *)node)->type;
    }
    if (node->nodetype == LYS_LEAFLIST) {
        return ((const struct lysc_node_leaflist *)node)->type;
    }
    return NULL;
}

static void
json_schema_key(struct json_buffer *buffer, const struct lysc_node *node)
{
    const struct lysc_node *child;
    int first = 1;

    json_raw(buffer, "[");
    if (node->nodetype == LYS_LIST) {
        for (child = lysc_node_child(node); child && (child->parent == node); child = child->next) {
            if ((child->nodetype == LYS_LEAF) && (child->flags & LYS_KEY)) {
                if (!first) {
                    json_raw(buffer, ",");
                }
                json_string(buffer, child->name);
                first = 0;
            }
        }
    }
    json_raw(buffer, "]");
}

static void
json_if_features(struct json_buffer *buffer, const struct lysc_node *node)
{
    const struct lysp_node *parsed = (const struct lysp_node *)node->priv;
    LY_ARRAY_COUNT_TYPE index;

    json_raw(buffer, "[");
    if (parsed) {
        LY_ARRAY_FOR(parsed->iffeatures, index) {
            if (index) {
                json_raw(buffer, ",");
            }
            json_string(buffer, parsed->iffeatures[index].str);
        }
    }
    json_raw(buffer, "]");
}

static void
json_default(struct json_buffer *buffer, const struct lysc_node *node)
{
    const struct lysc_node_leaf *leaf;
    const struct lysc_node_leaflist *leaflist;
    LY_ARRAY_COUNT_TYPE index;

    if (node->nodetype == LYS_LEAF) {
        leaf = (const struct lysc_node_leaf *)node;
        json_string(buffer, leaf->dflt.str);
    } else if (node->nodetype == LYS_LEAFLIST) {
        leaflist = (const struct lysc_node_leaflist *)node;
        if (!leaflist->dflts) {
            json_raw(buffer, "null");
            return;
        }
        json_raw(buffer, "[");
        LY_ARRAY_FOR(leaflist->dflts, index) {
            if (index) {
                json_raw(buffer, ",");
            }
            json_string(buffer, leaflist->dflts[index].str);
        }
        json_raw(buffer, "]");
    } else if (node->nodetype == LYS_CHOICE) {
        const struct lysc_node_choice *choice = (const struct lysc_node_choice *)node;
        json_string(buffer, choice->dflt ? choice->dflt->name : NULL);
    } else {
        json_raw(buffer, "null");
    }
}

static void
json_min_elements(struct json_buffer *buffer, const struct lysc_node *node)
{
    if (node->nodetype == LYS_LIST) {
        json_size(buffer, ((const struct lysc_node_list *)node)->min);
    } else if (node->nodetype == LYS_LEAFLIST) {
        json_size(buffer, ((const struct lysc_node_leaflist *)node)->min);
    } else {
        json_raw(buffer, "null");
    }
}

static void
json_max_elements(struct json_buffer *buffer, const struct lysc_node *node)
{
    uint32_t max;

    if (node->nodetype == LYS_LIST) {
        max = ((const struct lysc_node_list *)node)->max;
    } else if (node->nodetype == LYS_LEAFLIST) {
        max = ((const struct lysc_node_leaflist *)node)->max;
    } else {
        json_raw(buffer, "null");
        return;
    }
    if (max) {
        json_size(buffer, max);
    } else {
        json_string(buffer, "unbounded");
    }
}

static void
json_common_null_fields(struct json_buffer *buffer, const char *reference)
{
    json_raw(buffer, ",\"reference\":");
    json_string(buffer, reference);
    json_raw(buffer,
            ",\"config\":null,\"mandatory\":null,\"type\":null,\"units\":null,"
            "\"default\":null,\"schemaKey\":[],\"minElements\":null,\"maxElements\":null,"
            "\"presence\":null,\"ifFeatures\":[]");
}

static void
json_module_node(struct json_buffer *buffer, const struct export_node *node)
{
    const struct lys_module *module = node->module_root;

    json_raw(buffer, "{");
    json_key(buffer, "id"); json_string(buffer, node->id);
    json_raw(buffer, ","); json_key(buffer, "parentId"); json_string(buffer, node->parent_id);
    json_raw(buffer, ","); json_key(buffer, "name"); json_string(buffer, module->name);
    json_raw(buffer, ",\"keyword\":\"module\","); json_key(buffer, "module"); json_string(buffer, module->name);
    json_raw(buffer, ","); json_key(buffer, "revision"); json_string(buffer, module->revision);
    json_raw(buffer, ","); json_key(buffer, "namespace"); json_string(buffer, module->ns);
    json_raw(buffer, ","); json_key(buffer, "path"); json_string(buffer, node->path);
    json_raw(buffer, ","); json_key(buffer, "description"); json_string(buffer, module->dsc);
    json_raw(buffer, ",\"status\":\"current\"");
    json_common_null_fields(buffer, module->ref);
    json_raw(buffer, ",\"hasChildren\":"); json_raw(buffer, node->child_count ? "true" : "false");
    json_raw(buffer, ",\"childCount\":"); json_size(buffer, node->child_count);
    json_raw(buffer, "}");
}

static void
json_schema_node(struct json_buffer *buffer, const struct export_node *record)
{
    const struct lysc_node *node = record->schema;
    const struct lysc_type *type = schema_type(node);
    const char *type_name = NULL;

    if (type) {
        type_name = type->name ? type->name : ly_data_type2str[type->basetype];
    }
    json_raw(buffer, "{");
    json_key(buffer, "id"); json_string(buffer, record->id);
    json_raw(buffer, ","); json_key(buffer, "parentId"); json_string(buffer, record->parent_id);
    json_raw(buffer, ","); json_key(buffer, "name"); json_string(buffer, node->name);
    json_raw(buffer, ","); json_key(buffer, "keyword"); json_string(buffer, schema_keyword(node));
    json_raw(buffer, ","); json_key(buffer, "module"); json_string(buffer, node->module->name);
    json_raw(buffer, ","); json_key(buffer, "revision"); json_string(buffer, node->module->revision);
    json_raw(buffer, ","); json_key(buffer, "namespace"); json_string(buffer, node->module->ns);
    json_raw(buffer, ","); json_key(buffer, "path"); json_string(buffer, record->path);
    json_raw(buffer, ","); json_key(buffer, "description"); json_string(buffer, node->dsc);
    json_raw(buffer, ","); json_key(buffer, "reference"); json_string(buffer, node->ref);
    json_raw(buffer, ","); json_key(buffer, "status"); json_string(buffer, schema_status(node));
    json_raw(buffer, ",\"config\":");
    if (schema_has_config(node)) {
        json_raw(buffer, (node->flags & LYS_CONFIG_W) ? "true" : "false");
    } else {
        json_raw(buffer, "null");
    }
    json_raw(buffer, ",\"mandatory\":");
    if (schema_has_mandatory(node)) {
        json_raw(buffer, (node->flags & LYS_MAND_TRUE) ? "true" : "false");
    } else {
        json_raw(buffer, "null");
    }
    json_raw(buffer, ","); json_key(buffer, "type"); json_string(buffer, type_name);
    json_raw(buffer, ","); json_key(buffer, "units");
    if (node->nodetype == LYS_LEAF) {
        json_string(buffer, ((const struct lysc_node_leaf *)node)->units);
    } else if (node->nodetype == LYS_LEAFLIST) {
        json_string(buffer, ((const struct lysc_node_leaflist *)node)->units);
    } else {
        json_raw(buffer, "null");
    }
    json_raw(buffer, ",\"default\":"); json_default(buffer, node);
    json_raw(buffer, ",\"schemaKey\":"); json_schema_key(buffer, node);
    json_raw(buffer, ",\"minElements\":"); json_min_elements(buffer, node);
    json_raw(buffer, ",\"maxElements\":"); json_max_elements(buffer, node);
    json_raw(buffer, ",\"presence\":");
    if (node->nodetype == LYS_CONTAINER) {
        /* Compiled flags include uses/refine amendments; node->priv may still point to the original parsed node. */
        json_raw(buffer, (node->flags & LYS_PRESENCE) ? "true" : "false");
    } else {
        json_raw(buffer, "null");
    }
    json_raw(buffer, ",\"ifFeatures\":"); json_if_features(buffer, node);
    json_raw(buffer, ",\"hasChildren\":"); json_raw(buffer, record->child_count ? "true" : "false");
    json_raw(buffer, ",\"childCount\":"); json_size(buffer, record->child_count);
    json_raw(buffer, "}");
}

static int
serialize_tree(struct json_buffer *buffer, const struct export_tree *tree)
{
    size_t index, child;

    json_raw(buffer,
            "{\"schemaVersion\":1,\"authoritative\":true,\"source\":\"libyang-effective\","
            "\"scope\":\"core-effective-schema\","
            "\"rootId\":\"yang-schema-root\",\"roots\":[");
    for (index = 0; index < tree->root_count; ++index) {
        if (index) {
            json_raw(buffer, ",");
        }
        json_string(buffer, tree->nodes[tree->roots[index]].id);
    }
    json_raw(buffer, "],\"nodes\":{");
    for (index = 0; index < tree->count; ++index) {
        if (index) {
            json_raw(buffer, ",");
        }
        json_string(buffer, tree->nodes[index].id);
        json_raw(buffer, ":");
        if (tree->nodes[index].module_root) {
            json_module_node(buffer, &tree->nodes[index]);
        } else {
            json_schema_node(buffer, &tree->nodes[index]);
        }
    }
    json_raw(buffer, "},\"childIndex\":{");
    json_string(buffer, ROOT_NODE_ID);
    json_raw(buffer, ":[");
    for (index = 0; index < tree->root_count; ++index) {
        if (index) {
            json_raw(buffer, ",");
        }
        json_string(buffer, tree->nodes[tree->roots[index]].id);
    }
    json_raw(buffer, "]");
    for (index = 0; index < tree->count; ++index) {
        json_raw(buffer, ",");
        json_string(buffer, tree->nodes[index].id);
        json_raw(buffer, ":[");
        for (child = 0; child < tree->nodes[index].child_count; ++child) {
            if (child) {
                json_raw(buffer, ",");
            }
            json_string(buffer, tree->nodes[tree->nodes[index].children[child]].id);
        }
        json_raw(buffer, "]");
    }
    json_raw(buffer, "},\"nodeCount\":");
    json_size(buffer, tree->count);
    json_raw(buffer, "}\n");
    return buffer->failed ? -1 : 0;
}

static void
print_usage(FILE *stream)
{
    fprintf(stream,
            "Usage: netnexus-libyang-schema [-p DIR]... [-F MODULE:FEATURES]... "
            "[-D DEVIATION.yang]... [--schema-list PATHS.list]... MODULE.yang...\n"
            "Schema path lists contain UTF-8 paths separated and terminated by NUL bytes.\n");
}

static const char *
required_option_value(int argc, char **argv, int *index, const char *option)
{
    if (*index + 1 >= argc) {
        fprintf(stderr, "Option %s requires a value.\n", option);
        return NULL;
    }
    ++*index;
    return argv[*index];
}

int
main(int argc, char **argv)
{
    struct string_list search_paths = {0}, deviations = {0}, schema_paths = {0};
    struct feature_specs feature_specs = {0};
    struct module_list modules = {0}, deviation_modules = {0};
    struct export_tree tree = {0};
    struct json_buffer json = {0};
    struct ly_ctx *context = NULL;
    struct lys_module *module = NULL;
    const char *value;
    char *directory = NULL, *initial_search_path = NULL;
    uint16_t context_options;
    size_t index;
    int argument, exit_code = EXIT_FAILURE;

#ifdef _WIN32
    if (!setlocale(LC_CTYPE, ".UTF8")) {
        fputs("Unable to enable the UTF-8 C runtime locale.\n", stderr);
        return EXIT_FAILURE;
    }
#endif

    for (argument = 1; argument < argc; ++argument) {
        if (!strcmp(argv[argument], "--version")) {
            printf("netnexus-libyang-schema %d (libyang %s)\n", EXPORT_SCHEMA_VERSION, ly_version_proj_str());
            exit_code = EXIT_SUCCESS;
            goto cleanup;
        }
        if (!strcmp(argv[argument], "--help") || !strcmp(argv[argument], "-h")) {
            print_usage(stdout);
            exit_code = EXIT_SUCCESS;
            goto cleanup;
        }
        if (!strcmp(argv[argument], "-p") || !strcmp(argv[argument], "--path")) {
            value = required_option_value(argc, argv, &argument, argv[argument]);
            if (!value || string_list_add(&search_paths, value, 1)) {
                goto cleanup;
            }
        } else if (!strcmp(argv[argument], "-F") || !strcmp(argv[argument], "--features")) {
            value = required_option_value(argc, argv, &argument, argv[argument]);
            if (!value || feature_specs_add(&feature_specs, value)) {
                goto cleanup;
            }
        } else if (!strcmp(argv[argument], "-D") || !strcmp(argv[argument], "--deviation")) {
            value = required_option_value(argc, argv, &argument, argv[argument]);
            if (!value || string_list_add(&deviations, value, 1)) {
                goto cleanup;
            }
        } else if (!strcmp(argv[argument], "--schema-list")) {
            value = required_option_value(argc, argv, &argument, argv[argument]);
            if (!value || load_schema_path_list(value, &schema_paths)) {
                goto cleanup;
            }
        } else if (argv[argument][0] == '-') {
            fprintf(stderr, "Unknown option '%s'.\n", argv[argument]);
            print_usage(stderr);
            goto cleanup;
        } else if (string_list_add(&schema_paths, argv[argument], 1)) {
            goto cleanup;
        }
    }
    if (!schema_paths.count) {
        fprintf(stderr, "At least one top-level YANG module is required.\n");
        print_usage(stderr);
        goto cleanup;
    }

    for (index = 0; index < schema_paths.count; ++index) {
        directory = path_directory(schema_paths.items[index]);
        if (!directory || string_list_add(&search_paths, directory, 1)) {
            free(directory);
            goto cleanup;
        }
        free(directory);
        directory = NULL;
    }
    for (index = 0; index < deviations.count; ++index) {
        directory = path_directory(deviations.items[index]);
        if (!directory || string_list_add(&search_paths, directory, 1)) {
            free(directory);
            goto cleanup;
        }
        free(directory);
        directory = NULL;
    }
    initial_search_path = join_search_paths(&search_paths);
    if (!initial_search_path) {
        fprintf(stderr, "Out of memory while preparing schema search paths.\n");
        goto cleanup;
    }

    /* Keep the effective-schema context consistent with yanglint's single --make-implemented
     * mode. Modules referenced from when/must/default expressions must be implemented even
     * when they were first encountered as imports before their explicit schema input. */
    context_options = LY_CTX_EXPLICIT_COMPILE | LY_CTX_DISABLE_SEARCHDIR_CWD | LY_CTX_STATIC_PLUGINS_ONLY |
            LY_CTX_SET_PRIV_PARSED | LY_CTX_REF_IMPLEMENTED;
    if (!feature_specs.count) {
        context_options |= LY_CTX_ENABLE_IMP_FEATURES;
    }
    if (ly_ctx_new(initial_search_path, context_options, &context) != LY_SUCCESS) {
        fprintf(stderr, "Unable to create the authoritative libyang context.\n");
        goto cleanup;
    }
    free(initial_search_path);
    initial_search_path = NULL;
    for (index = 0; index < search_paths.count; ++index) {
        LY_ERR result = ly_ctx_set_searchdir(context, search_paths.items[index]);
        if ((result != LY_SUCCESS) && (result != LY_EEXIST)) {
            fprintf(stderr, "Unable to add schema search directory '%s'.\n", search_paths.items[index]);
            goto cleanup;
        }
    }
    for (index = 0; index < schema_paths.count; ++index) {
        if (parse_schema_file(context, &feature_specs, schema_paths.items[index], &module) ||
                module_list_add(&modules, module)) {
            goto cleanup;
        }
    }
    for (index = 0; index < deviations.count; ++index) {
        if (parse_schema_file(context, &feature_specs, deviations.items[index], &module) ||
                module_list_add(&deviation_modules, module)) {
            goto cleanup;
        }
    }
    if (apply_remaining_features(&feature_specs, context)) {
        goto cleanup;
    }
    if (ly_ctx_compile(context) != LY_SUCCESS) {
        fprintf(stderr, "Authoritative libyang effective-schema compilation failed.\n");
        goto cleanup;
    }
    if (expand_relevant_modules(&modules, &deviation_modules, context)) {
        fprintf(stderr, "Unable to determine the relevant implemented module closure.\n");
        goto cleanup;
    }
    for (index = 0; index < modules.count; ++index) {
        if (module_list_contains(&deviation_modules, modules.items[index])) {
            continue;
        }
        if (!modules.items[index]->compiled) {
            fprintf(stderr, "Module '%s' has no compiled effective schema.\n", modules.items[index]->name);
            goto cleanup;
        }
        if (export_module(&tree, modules.items[index])) {
            fprintf(stderr, "Unable to export the effective schema for module '%s'.\n", modules.items[index]->name);
            goto cleanup;
        }
    }
    if (serialize_tree(&json, &tree)) {
        fprintf(stderr, "Unable to serialize the effective schema JSON.\n");
        goto cleanup;
    }
    if (fwrite(json.data, 1, json.length, stdout) != json.length) {
        fprintf(stderr, "Unable to write effective schema JSON.\n");
        goto cleanup;
    }
    exit_code = EXIT_SUCCESS;

cleanup:
    free(initial_search_path);
    free(directory);
    free(json.data);
    export_tree_erase(&tree);
    module_list_erase(&modules);
    module_list_erase(&deviation_modules);
    if (context) {
        ly_ctx_destroy(context);
    }
    feature_specs_erase(&feature_specs);
    string_list_erase(&schema_paths);
    string_list_erase(&deviations);
    string_list_erase(&search_paths);
    return exit_code;
}
