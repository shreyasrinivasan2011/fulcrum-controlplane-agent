/* The enums the operator manual names, quoted by chapter.
 *
 * One definition, two consumers: the documented-behaviour pack asserts against
 * these, and the learning loop uses them to catch itself overfitting — a model
 * shown four policies will happily claim the world holds four enforcement
 * values when the manual documents eight.
 */

/** The enums the manual names, quoted by chapter. */
export const DOC = {
  roles:            ['owner', 'admin', 'operator', 'approver', 'member', 'viewer'],
  agentPlatforms:   ['Azure AI Foundry', 'Copilot Studio', 'M365 Copilot', 'Power Platform', 'Custom Agent'],
  agentTypes:       ['Pro-code', 'Low-code', 'Copilot'],
  agentStatus:      ['Pending Review', 'Active', 'Inactive'],
  policyEnforcement:['Block', 'Require Approval', 'Escalate', 'Mask', 'Route', 'Throttle', 'Warn', 'Log Only'],
  policyScope:      ['Global', 'Environment', 'Agent', 'Connector'],
  policyStatus:     ['Active', 'Inactive', 'Warning', 'Pending Review'],
  policyCategories: ['Access Control', 'Guardrails', 'Data Protection', 'Approval & Escalation',
                     'Routing & Orchestration', 'Usage & Quotas', 'Logging & Retention', 'Security', 'Compliance'],
  guardrailActions: ['Warn', 'Block', 'Mask', 'Log'],          // "there is no Passed"
  guardrailTested:  ['PII', 'Topic', 'Prompt Injection'],      // what this deployment implements
  connectorTypes:   ['API', 'MCP Server', 'Database', 'Vector Store', 'Custom Tool'],
  connectorAccess:  ['Read', 'Read-Write', 'Admin'],
  connectionKinds:  ['Azure AI Foundry', 'Copilot Studio', 'MCP Server', 'Vector Database',
                     'Microsoft Purview', 'Custom REST API'],
  runStatus:        ['Completed', 'Warned', 'Failed', 'Running'],
  policyResult:     ['Allowed', 'Warned', 'Blocked'],
  environments:     ['Production', 'Staging', 'UAT', 'Development', 'QA', 'Sandbox', 'DR'],
  alertSeverity:    ['Critical', 'High', 'Medium', 'Low', 'Info'],
  keyScopes:        ['ingest', 'read', 'admin'],
  spanTypes:        ['general', 'llm', 'tool', 'guardrail'],
  seriesMetrics:    ['runs', 'success_rate', 'latency_p50', 'latency_p90',
                     'tokens', 'cost', 'violations', 'escalations'],
  metricWindows:    ['24h', '7d', '30d', '90d'],
  feedbackSeverity: ['Critical', 'High', 'Medium', 'Low'],
  hardEntitlements: ['included_seats', 'included_tokens', 'included_runs'],
};

/**
 * Where a documented enum governs a field, keyed by endpoint and field path.
 * An `enum_subset` proposal on one of these is checked against the manual
 * rather than against whatever the sample happened to contain.
 */
export const DOCUMENTED_ENUMS = {
  '/agents|status':                    DOC.agentStatus,
  '/agents|platform':                  DOC.agentPlatforms,
  '/agents|agent_type':                DOC.agentTypes,
  '/agents|environment':               DOC.environments,
  '/agents|policy_status':             DOC.policyResult,
  '/runs|status':                      DOC.runStatus,
  '/runs|policy':                      DOC.policyResult,
  '/policies|enforcement':             DOC.policyEnforcement,
  '/policies|scope':                   DOC.policyScope,
  '/policies|status':                  DOC.policyStatus,
  '/policies|category':                DOC.policyCategories,
  '/guardrails|action':                DOC.guardrailActions,
  '/guardrails|guardrail_type':        DOC.guardrailTested,
  '/guardrails|scope':                 DOC.policyScope,
  '/guardrails/events|action_taken':   DOC.guardrailActions,
  '/guardrails/events|guardrail_type': DOC.guardrailTested,
  '/connectors|connector_type':        DOC.connectorTypes,
  '/connectors|access':                DOC.connectorAccess,
  '/connections|kind':                 DOC.connectionKinds,
  '/alerts|severity':                  DOC.alertSeverity,
  '/workspaces/users|role':            DOC.roles,
  '/workspaces/api-keys|scopes':       DOC.keyScopes,
  '/environments|env_type':            DOC.environments,
};
