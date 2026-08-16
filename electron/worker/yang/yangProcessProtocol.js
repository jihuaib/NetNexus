'use strict';

const YANG_PROCESS_REQ_TYPES = Object.freeze({
    CONFIGURE: 'yang-process:configure',
    SET_ACTIVE_PROFILE: 'yang-process:set-active-profile',
    IMPORT_DOWNLOADED_CONTENTS: 'yang-process:import-downloaded-contents',
    DOWNLOAD_MODULES: 'yang-process:download-modules',
    GET_TASK: 'yang-process:get-task',
    CANCEL_TASK: 'yang-process:cancel-task',
    DELETE_PROFILE_WORKSPACE: 'yang-process:delete-profile-workspace',
    GET_WORKSPACE_GENERATION: 'yang-process:get-workspace-generation',
    CLOSE: 'yang-process:close'
});

const YANG_PROCESS_EVT_TYPES = Object.freeze({
    STATE_UPDATE: 'yang-process:state-update'
});

const YANG_RENDERER_CHANNELS = Object.freeze([
    'yang:listModules',
    'yang:importFiles',
    'yang:importDirectory',
    'yang:compile',
    'yang:getCompilerStatus',
    'yang:clearWorkspace',
    'yang:getWorkspace',
    'yang:getSchemaRoots',
    'yang:getSchemaChildren',
    'yang:getSchemaNode',
    'yang:validateRpc',
    'yang:getModuleSource',
    'yang:getDiagnostics'
]);

module.exports = {
    YANG_PROCESS_REQ_TYPES,
    YANG_PROCESS_EVT_TYPES,
    YANG_RENDERER_CHANNELS
};
