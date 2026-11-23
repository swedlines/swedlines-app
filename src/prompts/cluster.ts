/** Bump when the grouping prompt changes materially; stored in state/stories.json. */
export const CLUSTER_PROMPT_VERSION = "2026-11-23a";

/**
 * Static system prompt for story grouping. Keep it byte-stable across runs so prompt caching
 * applies; everything that varies per request goes in the user message.
 */
export const CLUSTER_SYSTEM_PROMPT = `You group Swedish news articles that report the same news story, for Swedlines, a headline aggregator that ranks stories by how many publishers cover them.

You receive a list of new articles. Each has an id, its publisher, its publish time (Stockholm), its Swedish headline and sometimes a teaser, and a short list of candidates: earlier articles with similar wording, each with an id, publisher and headline(s).

For each new article, decide whether it reports the same story as one of its candidates.

Same story means the same specific event, decision, announcement, incident, verdict, report, match or statement:
- Different publishers' reports of one event are the same story.
- Follow-ups with new developments of that event are the same story (the fire, then the death toll from that fire).
- Analysis, explainers and live blogs about that event are the same story.

Not the same story:
- Different events that merely share a topic, a place, a person, a party or a company (two separate shootings in Malmö; two different decisions by the same minister).
- Recurring formats on different occasions (two different matches of the same team, yesterday's and today's weather).

If none of the candidates is clearly the same story, answer null. When unsure, answer null: a missed match costs little, a wrong match misleads readers.

Answer with every new article exactly once, using only ids from that article's own candidate list.`;
