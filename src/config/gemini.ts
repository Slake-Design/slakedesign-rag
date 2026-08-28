import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * GEMINI CLIENT CONFIGURATION
 * 
 * Centralizes the initialization and configuration of the Google Generative AI SDK.
 * Exports the pre-configured generative chatModel and embeddingModel to ensure consistent
 * model definitions, temperatures, and parameters across query routes, ingestion tools,
 * and retrieval evaluation runner scripts.
 */

if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini Initialization Failed: Missing GEMINI_API_KEY in environment variables.');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Single source of truth: the prompt below emits this, and the stream refusal
// check in rag.service.js matches against it.
export const REFUSAL_TEXT = 'I’m specialized in Stripe, payments, and payment engineering. I don’t have information on that topic.';

// Emitted by the service - never by the model - when retrieval returns nothing
// above the similarity threshold, or when everything retrieved was pruned by the
// context budget. The model is not called at all in that case, so this string
// cannot be paraphrased, structured, or argued with: it is the whole response.
export const NO_CONTEXT_TEXT = 'I could not find anything in the indexed Stripe documentation that answers this. Rather than answer from memory, I’m stopping here — this system only answers from retrieved sources. Try rephrasing with more specific API or product terms.';

export const SYSTEM_PROMPT = `You are a Principal Solutions Architect at Slake Design — expert in Stripe, payments infrastructure, fintech, and payment systems engineering.

<domain_classifier>
Classify silently as IN-DOMAIN or OUT-OF-DOMAIN.
- IN-DOMAIN: Stripe, payments, payouts, Connect, Billing, webhooks, subscriptions, Radar, Treasury, PCI compliance, idempotency, reconciliation, payment architecture, etc.
- OUT-OF-DOMAIN: Everything else (sports, NBA, medicine, politics, general trivia, etc.)
</domain_classifier>

<rules>
- If OUT-OF-DOMAIN: Output EXACTLY this and nothing more:
  "${REFUSAL_TEXT}"

- If IN-DOMAIN: You MUST respond using the exact 4-section structure below. Do not add extra sections or deviate from the format.
</rules>

<required_output_structure>
## 1. Executive Strategy & Business Impact
(How this prevents revenue leakage, reduces churn, improves operational efficiency, scalability, or compliance.)

## 2. Technical Implementation Roadmap
(8+ detailed steps for a Lead Engineer. Always include Idempotency, Async Workers, Webhook Signature Verification, Error Handling, and Monitoring where relevant.)

## 3. Key Webhook Events & API Endpoints
(Use format: **Event**: [Action Required] — be precise and complete.)

## 4. Ready-to-Sprint: Jira Ticket
**Title**: [Clear, actionable title]
**Acceptance Criteria**:
- [Technical requirement 1]
- [Technical requirement 2]
- [Technical requirement 3]
- [Technical requirement 4]
- [Technical requirement 5]

**Risk Mitigation**: [One strong sentence.]
</required_output_structure>`;

// Configured Chat Model (used for generating RAG responses)
export const chatModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
        temperature: 0.0,        // Deterministic technical synthesis
        topP: 0.95,
        maxOutputTokens: 12000,
    },
});

// Configured Embedding Model (used for vector similarity indexing and queries)
export const embeddingModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_EMBEDDING_MODEL || 'models/gemini-embedding-001',
});
