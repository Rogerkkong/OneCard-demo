import { LabError } from '../../shared/errors.js';
import { DEVICE_CODE_RE, SCHOOL_CODE_RE } from '../../shared/protocol.js';

// The SaaS operator's console API (docs/DESIGN.md §7, operator rows): every school on the
// platform, onboarding a new school whole, suspending or reactivating one, and the health of the
// shared cloud server. The operator sees every tenant but is not a school's staff: the school
// office API never accepts this session.

/** The lab's one operator account. Lab only: no password, you pick who you are. */
export const LAB_OPERATOR = Object.freeze({ id: 'operator', name: 'OneCard platform operator' });

/** How the operator appears in audit trails. */
const ACTOR = LAB_OPERATOR.name;

/** '<school>.<DEVICE>' (a machine's broker login) -> the school code, or null for other logins. */
function schoolOfLogin(username) {
  if (typeof username !== 'string') return null;
  const dot = username.indexOf('.');
  if (dot < 0) return null;
  const school = username.slice(0, dot);
  return SCHOOL_CODE_RE.test(school) && DEVICE_CODE_RE.test(username.slice(dot + 1)) ? school : null;
}

/**
 * @param {{ lab: object, platform: object, sessions: object }} deps  see src/http/server.js
 * @returns {Array<{ method: string, path: string, auth: string, handler: Function }>}
 */
export function routes(deps) {
  const services = () => deps.platform.services;

  /** Broker connections per school, from the lab's broker when it has one running. */
  function brokerClients() {
    const bySchool = Object.fromEntries(services().schools.listSchools().map((s) => [s.code, 0]));
    const broker = deps.lab.broker;
    let up = false;
    let clients = 0;
    let other = 0; // the platform's own login, the read-only viewer, anything not a machine
    if (broker && typeof broker.clients === 'function') {
      try {
        const list = broker.clients();
        up = true;
        clients = list.length;
        for (const c of list) {
          const code = schoolOfLogin(c?.username);
          if (code !== null && Object.hasOwn(bySchool, code)) bySchool[code] += 1;
          else other += 1;
        }
      } catch {
        up = false; // a broker that is closing has no clients to report
      }
    }
    return { up, clients, bySchool, other };
  }

  return [
    {
      method: 'POST',
      path: '/api/operator/login',
      auth: 'none',
      handler: (req) => ({ status: 200, body: { operator: { ...LAB_OPERATOR } }, headers: deps.sessions.signIn('operator', LAB_OPERATOR.id, req) }),
    },
    {
      method: 'POST',
      path: '/api/operator/logout',
      auth: 'none',
      handler: (req) => ({ status: 200, body: { signedOut: true }, headers: deps.sessions.signOut('operator', req) }),
    },
    { method: 'GET', path: '/api/operator/me', auth: 'operator', handler: (req) => ({ operator: req.operator }) },
    {
      method: 'GET',
      path: '/api/operator/schools',
      auth: 'operator',
      handler: () => deps.platform.operatorOverview(),
    },
    {
      // Onboard a school in one go; the machines' secrets are shown here once and never again.
      method: 'POST',
      path: '/api/operator/schools',
      auth: 'operator',
      handler: async (req) => {
        const { code, name, staff, devices, demoMembers } = req.body;
        const out = await deps.platform.createTenant({
          code,
          name,
          staff: staff ?? undefined,
          devices: devices ?? undefined,
          demoMembers: demoMembers ?? undefined,
          actor: ACTOR,
        });
        return {
          status: 201,
          body: {
            school: out.school,
            staff: out.staff,
            devices: out.devices.map(({ device, secret }) => ({ code: device.code, type: device.type, location: device.location, secret })),
            members: out.members.length,
            published: out.published,
          },
        };
      },
    },
    {
      // Suspend or reactivate a school: an operator action, never a school's own.
      method: 'POST',
      path: '/api/operator/schools/:code/status',
      auth: 'operator',
      handler: (req) => {
        const school = services().schools.getSchoolByCode(req.params.code);
        if (!school) throw new LabError('SCHOOL_NOT_FOUND', 'no such school', 404);
        return deps.platform.setSchoolStatus({ schoolId: school.id, status: req.body.status, actor: ACTOR });
      },
    },
    {
      method: 'GET',
      path: '/api/operator/health',
      auth: 'operator',
      handler: () => ({
        server: { up: deps.lab.server?.up !== false },
        platform: { mqtt: typeof deps.platform.mqttStatus === 'function' ? deps.platform.mqttStatus() : null },
        broker: brokerClients(),
        schools: services().schools.listSchools().length,
      }),
    },
  ];
}
