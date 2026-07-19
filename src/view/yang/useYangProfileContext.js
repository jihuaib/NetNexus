import { computed, ref } from 'vue';
import { invokeBridge, unwrapArray } from './yangUiUtils';

const profiles = ref([]);
const selectedProfileId = ref('');
const profilesLoading = ref(false);
let pendingProfiles = null;
let profilesEpoch = 0;

const normalizeProfile = profile => ({
    ...(profile || {}),
    id: String(profile?.id || profile?.profileId || '')
});

const isSavedProfileId = profileId => Boolean(profileId) && !String(profileId).startsWith('draft-');

const selectYangProfile = profileOrId => {
    const profileId = String(profileOrId?.id || profileOrId?.profileId || profileOrId || '');
    const nextProfileId = isSavedProfileId(profileId) ? profileId : '';
    if (nextProfileId !== selectedProfileId.value) profilesEpoch += 1;
    selectedProfileId.value = nextProfileId;
    return selectedProfileId.value;
};

const replaceYangProfiles = (nextProfiles, options = {}) => {
    const requestEpoch = Number(options.requestEpoch);
    if (Number.isFinite(requestEpoch) && requestEpoch !== profilesEpoch) return profiles.value;
    if (!Number.isFinite(requestEpoch)) profilesEpoch += 1;
    const normalized = (nextProfiles || []).map(normalizeProfile).filter(profile => isSavedProfileId(profile.id));
    profiles.value = normalized;
    const preferredId = String(options.preferredId || '');
    const retained = normalized.find(profile => profile.id === selectedProfileId.value);
    const preferred = normalized.find(profile => profile.id === preferredId);
    const next = options.preferPreferred === true ? preferred || retained : retained || preferred;
    const selected = next || normalized[0] || null;
    selectedProfileId.value = selected?.id || '';
    return normalized;
};

const refreshYangProfiles = async (options = {}) => {
    if (pendingProfiles && options.force !== true) return pendingProfiles;
    const requestEpoch = ++profilesEpoch;
    profilesLoading.value = true;
    const request = invokeBridge('netconfApi', 'listProfiles')
        .then(({ data }) => {
            const activeProfileId = data?.activeProfileId || data?.session?.profileId || '';
            return replaceYangProfiles(unwrapArray(data, ['profiles', 'items']), {
                preferredId: options.preferredId || activeProfileId,
                preferPreferred: Boolean(activeProfileId) || options.preferPreferred === true,
                requestEpoch
            });
        })
        .finally(() => {
            if (pendingProfiles === request) {
                profilesLoading.value = false;
                pendingProfiles = null;
            }
        });
    pendingProfiles = request;
    return request;
};

const upsertYangProfile = (profile, options = {}) => {
    const normalized = normalizeProfile(profile);
    if (!isSavedProfileId(normalized.id)) return null;
    profilesEpoch += 1;
    const index = profiles.value.findIndex(item => item.id === normalized.id);
    if (index >= 0) profiles.value.splice(index, 1, normalized);
    else profiles.value.push(normalized);
    if (options.select !== false) selectedProfileId.value = normalized.id;
    return normalized;
};

const removeYangProfile = profileId => {
    const id = String(profileId || '');
    const index = profiles.value.findIndex(profile => profile.id === id);
    if (index >= 0) {
        profilesEpoch += 1;
        profiles.value.splice(index, 1);
    }
    if (selectedProfileId.value === id) {
        selectedProfileId.value = profiles.value[Math.min(index, profiles.value.length - 1)]?.id || '';
    }
    return selectedProfileId.value;
};

const taskScope = task => {
    const metadata = task?.metadata || task?.meta || task?.task?.metadata || {};
    const result = task?.result || {};
    return {
        profileId: String(task?.profileId || metadata.profileId || result.profileId || ''),
        workspaceId: String(task?.workspaceId || metadata.workspaceId || result.workspaceId || '')
    };
};

const taskMatchesYangProfile = (task, profileId) => {
    const expected = String(profileId || '');
    const scope = taskScope(task);
    if (scope.profileId) return scope.profileId === expected;
    if (!scope.workspaceId) return true;
    return [expected, `profile-${expected}`, `profile:${expected}`].includes(scope.workspaceId);
};

export const useYangProfileContext = () => ({
    profiles,
    profilesLoading,
    selectedProfileId,
    selectedProfile: computed(() => profiles.value.find(profile => profile.id === selectedProfileId.value) || null),
    profileOptions: computed(() =>
        profiles.value.map(profile => ({
            label: profile.name || profile.host || profile.id,
            value: profile.id
        }))
    ),
    refreshProfiles: refreshYangProfiles,
    replaceProfiles: replaceYangProfiles,
    selectProfile: selectYangProfile,
    upsertProfile: upsertYangProfile,
    removeProfile: removeYangProfile,
    taskMatchesProfile: taskMatchesYangProfile
});
