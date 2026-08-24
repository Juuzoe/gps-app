const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const ABBREVS = new Set(Object.values(STATES));

/** "Indiana" -> "IN", "IN" -> "IN", unknown -> null. */
export function toStateAbbrev(name: string): string | null {
  const trimmed = name.trim();
  const upper = trimmed.toUpperCase();
  if (ABBREVS.has(upper)) return upper;
  return STATES[trimmed.toLowerCase()] ?? null;
}

export function stateName(abbrev: string): string {
  for (const [name, ab] of Object.entries(STATES)) {
    if (ab === abbrev) return name.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return abbrev;
}
