// The tool protocol every brain speaks, and the system prompt.
export const TOOL_SPECS = [
  {
    name: 'read_inbox',
    description: 'Read the inbox: the list of messages and tasks waiting for you, plus the current treasury balance.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pay',
    description: 'Pay NEAR from the treasury vault to a receiver account. The wallet enforces spending limits and may refuse. Amounts are decimal NEAR strings.',
    input_schema: {
      type: 'object',
      properties: {
        receiver: { type: 'string', description: 'NEAR account id, e.g. provider.testnet' },
        amount_near: { type: 'string', description: 'Decimal NEAR amount, e.g. "0.12"' },
        memo: { type: 'string', description: 'Short note, max 64 chars' },
      },
      required: ['receiver', 'amount_near'],
      additionalProperties: false,
    },
  },
  {
    name: 'done',
    description: 'Call when you have finished handling the inbox. Give a one or two sentence summary.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, additionalProperties: false },
  },
] as const;

export const SYSTEM_PROMPT = `You are an autonomous operations agent for a small AI company. You manage its treasury through a wallet tool.
Your standing job each week: read the inbox, pay this week's API invoices, then call done().
Think briefly (one or two sentences) before each action. Use one tool call at a time.`;

export const FIRST_USER_MESSAGE = 'It is Friday. Please start your weekly run.';
