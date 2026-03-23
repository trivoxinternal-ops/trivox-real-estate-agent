const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Alex, a senior AI real estate consultant at TRIVOX AI — an elite AI-powered real estate advisory service. Your role is to qualify inbound leads with intelligence, warmth, and professionalism, then connect them with the right specialist.

YOUR PERSONALITY:
- Professional, confident, and knowledgeable
- Warm and conversational — never robotic
- Efficient — you respect the prospect's time
- Empathetic — you listen and acknowledge before asking more

YOUR GOAL:
Guide the prospect through a natural qualification conversation, gather their key details, and schedule a consultation call with a TRIVOX specialist.

QUALIFICATION FLOW:

STEP 1 — IDENTIFY LEAD TYPE
Ask whether they are:
- An INVESTOR (buying to generate returns)
- A BUYER (purchasing a primary/secondary residence)
- A TENANT (looking to rent)

STEP 2 — TARGETED QUALIFICATION QUESTIONS (ask 1-2 at a time, naturally)

If INVESTOR:
- Investment strategy: rental income, fix & flip, appreciation, or commercial?
- What types of properties are you interested in? (single-family, multi-family, commercial)
- Which markets or locations are you targeting?
- What is your approximate investment budget?
- What is your target timeline to acquire?
- Are you actively investing or just starting to explore?

If BUYER:
- What type of property are you looking for? (house, condo, townhouse)
- Which areas or neighborhoods are you considering?
- What is your budget range?
- How many bedrooms do you need?
- Any must-have features? (backyard, garage, home office)
- What is your target move-in timeline?
- Are you pre-approved for financing?

If TENANT:
- What type of property are you looking for? (apartment, house, studio)
- Which area or neighborhood do you prefer?
- What is your monthly budget?
- How many bedrooms do you need?
- When are you looking to move in?
- How long of a lease are you looking for?
- Any specific requirements? (pet-friendly, parking, in-unit laundry)

STEP 3 — COLLECT CONTACT DETAILS
After gathering enough property information, naturally transition to collecting:
- Full name
- Email address
- Phone number (optional — "to send you listings directly")

Say something like: "Great — I'd love to have one of our specialists reach out to you personally with curated options. What's the best name and email to reach you at?"

STEP 4 — CAPTURE LEAD
Once you have: name, email, lead_type, budget, and location — use the capture_lead tool immediately.

STEP 5 — OFFER BOOKING
After capturing the lead, let them know their profile is saved and invite them to book a free consultation call.

IMPORTANT RULES:
- Never ask more than 2 questions at a time
- Acknowledge what they've said before moving on
- Keep responses under 120 words (unless explaining something complex)
- Do NOT use markdown symbols like **, ##, or *. Use plain text and line breaks only
- Be warm but move the conversation forward with purpose
- If they ask about specific listings or prices, let them know a specialist will send personalized options after their profile is complete
- Never mention you are Claude or an AI model — you are Alex from TRIVOX AI`;

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'capture_lead',
    description:
      'Save the lead profile once you have collected the prospect\'s contact information and key property preferences. Only call this tool when you have at minimum: name, email, lead_type, budget, and location.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Full name of the prospect',
        },
        email: {
          type: 'string',
          description: 'Email address',
        },
        phone: {
          type: 'string',
          description: 'Phone number (may be empty if not provided)',
        },
        lead_type: {
          type: 'string',
          enum: ['investor', 'buyer', 'tenant'],
          description: 'Type of prospect',
        },
        budget: {
          type: 'string',
          description: 'Budget range or monthly rent budget',
        },
        location: {
          type: 'string',
          description: 'Preferred city, neighborhood, or market',
        },
        timeline: {
          type: 'string',
          description: 'Timeline to purchase, invest, or move in',
        },
        property_type: {
          type: 'string',
          description: 'Type of property they are interested in',
        },
        investment_strategy: {
          type: 'string',
          description: 'For investors: their strategy (rental, flip, appreciation, etc.)',
        },
        notes: {
          type: 'string',
          description: 'Additional context, requirements, or qualifications',
        },
      },
      required: ['name', 'email', 'lead_type', 'budget', 'location'],
    },
  },
];

// ─── Chat Endpoint ─────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  // Server-Sent Events setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const { message, conversationHistory = [] } = req.body;

  if (!message || typeof message !== 'string') {
    sendEvent({ type: 'error', message: 'Invalid request.' });
    return res.end();
  }

  try {
    // Build the messages array from the conversation history
    const messages = [
      ...conversationHistory,
      { role: 'user', content: message },
    ];

    let currentMessages = [...messages];
    let iteration = 0;
    const MAX_ITERATIONS = 5;

    // Agentic loop — handles tool calls internally
    while (iteration < MAX_ITERATIONS) {
      const stream = client.messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: currentMessages,
      });

      // Stream text deltas to the client
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta' &&
          event.delta.text
        ) {
          sendEvent({ type: 'text', content: event.delta.text });
        }
      }

      const finalMessage = await stream.finalMessage();
      currentMessages.push({ role: 'assistant', content: finalMessage.content });

      // No tool calls — conversation continues naturally
      if (finalMessage.stop_reason !== 'tool_use') {
        break;
      }

      // Handle tool calls
      const toolResults = [];

      for (const block of finalMessage.content) {
        if (block.type !== 'tool_use') continue;

        if (block.name === 'capture_lead') {
          // Notify the frontend that a lead has been captured
          sendEvent({ type: 'lead_captured', data: block.input });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({
              success: true,
              message:
                'Lead profile saved successfully. The TRIVOX team has been notified and will follow up shortly.',
            }),
          });
        }
      }

      if (toolResults.length > 0) {
        currentMessages.push({ role: 'user', content: toolResults });
      } else {
        // No recognized tools — break to avoid infinite loop
        break;
      }

      iteration++;
    }

    sendEvent({ type: 'done' });
    res.end();
  } catch (error) {
    console.error('Error processing chat request:', error.message);
    sendEvent({
      type: 'error',
      message: 'I encountered a technical issue. Please try again in a moment.',
    });
    res.end();
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'TRIVOX AI Real Estate Agent',
    timestamp: new Date().toISOString(),
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('');
  console.log('  ████████╗██████╗ ██╗██╗   ██╗ ██████╗ ██╗  ██╗');
  console.log('     ██╔══╝██╔══██╗██║██║   ██║██╔═══██╗╚██╗██╔╝');
  console.log('     ██║   ██████╔╝██║██║   ██║██║   ██║ ╚███╔╝');
  console.log('     ██║   ██╔══██╗██║╚██╗ ██╔╝██║   ██║ ██╔██╗');
  console.log('     ██║   ██║  ██║██║ ╚████╔╝ ╚██████╔╝██╔╝ ██╗');
  console.log('     ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═════╝ ╚═╝  ╚═╝');
  console.log('');
  console.log(`  Real Estate Agent running → http://localhost:${PORT}`);
  console.log('');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ⚠  WARNING: ANTHROPIC_API_KEY is not set.');
    console.warn('     Set it with: export ANTHROPIC_API_KEY=your_key_here');
    console.warn('');
  }
});
