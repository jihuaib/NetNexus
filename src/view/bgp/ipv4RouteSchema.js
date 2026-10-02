import registry from '../../../shared/bgpAttributes.json';
import { getDefaultAttributeRules, getDefaultNlriRules } from './bgpAttributeRules';

export const createIpv4RouteConfig = () => ({
    ...JSON.parse(JSON.stringify(registry.route.defaults)),
    nlriRules: getDefaultNlriRules(registry.route.defaults.addressFamily),
    attributeRules: getDefaultAttributeRules(registry.route.defaults.addressFamily)
});

export const IPV4_ROUTE_SECTIONS = [
    {
        id: 'prefix',
        title: '前缀范围',
        description: '设置起始前缀和数量，批量生成一组路由。',
        fields: registry.route.fields
    }
];

export const getVisibleRouteSections = () => IPV4_ROUTE_SECTIONS;
