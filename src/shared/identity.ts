import type { Identity, Known } from "./contracts.js";

// Identity derivation and comparison keys (addendum R2, R3, R4).
//
// Every attribute is derived from the current source text through the
// documented vocabulary below. There is no per-item map and no image parsing.
// Missing text is never evidence for a value: it yields "unknown", and
// "not-applicable" only comes from a documented category rule.

export type ItemCategory =
  | { category: "produce" | "meat"; reason: null }
  | { category: "excluded"; reason: string };

// ---------------------------------------------------------------------------
// Documented produce rules (R4)
// ---------------------------------------------------------------------------

/**
 * Kind vocabulary, most specific phrase first. A phrase may imply a variety
 * when a kind word is used as a modifier ("grape tomatoes" is a tomato).
 * [pattern, kind, implied variety template]
 */
const KIND_PHRASES: ReadonlyArray<readonly [string, string, string?]> = [
  ["(red|green|yellow|orange) bell peppers?", "pepper", "$1 bell"],
  ["grape tomato(?:es)?", "tomato", "grape"],
  ["cherry tomato(?:es)?", "tomato", "cherry"],
  ["plum tomato(?:es)?", "tomato", "plum"],
  ["romaine(?: lettuce)?", "lettuce", "romaine"],
  ["iceberg(?: lettuce)?", "lettuce", "iceberg"],
  ["sweet potato(?:es)?", "sweet potato"],
  ["green onions?|scallions?", "green onion"],
  ["green beans?", "green bean"],
  ["brussels? sprouts?", "brussels sprout"],
  ["meyer lemons?", "meyer lemon"],
  ["key limes?", "key lime"],
  ["honeydews?(?: melons?)?", "honeydew"],
  ["cantaloupes?", "cantaloupe"],
  ["watermelons?", "watermelon"],
  ["pineapples?", "pineapple"],
  ["zucchinis?(?: squash(?:es)?)?", "zucchini"],
  ["kiwi ?berr(?:y|ies)", "kiwi berry"],
  ["rainbow carrots?", "rainbow carrot"],
  ["apples?", "apple"],
  ["pears?", "pear"],
  ["grapes?", "grape"],
  ["potato(?:es)?", "potato"],
  ["onions?", "onion"],
  ["peppers?", "pepper"],
  ["mushrooms?", "mushroom"],
  ["tomato(?:es)?", "tomato"],
  ["oranges?", "orange"],
  ["lettuces?", "lettuce"],
  ["cabbages?", "cabbage"],
  ["squash(?:es)?", "squash"],
  ["cucumbers?", "cucumber"],
  ["avocados?", "avocado"],
  ["cherries|cherry", "cherry"],
  ["peach(?:es)?", "peach"],
  ["nectarines?", "nectarine"],
  ["plums?", "plum"],
  ["corn", "corn"],
  ["kale", "kale"],
  ["mangos|mangoes|mango", "mango"],
  ["kiwifruit|kiwis?", "kiwi"],
  ["grapefruits?", "grapefruit"],
  ["strawberries|strawberry", "strawberry"],
  ["raspberries|raspberry", "raspberry"],
  ["blackberries|blackberry", "blackberry"],
  ["blueberries|blueberry", "blueberry"],
  ["broccoli", "broccoli"],
  ["cauliflower", "cauliflower"],
  ["lemons?", "lemon"],
  ["limes?", "lime"],
  ["bananas?", "banana"],
  ["asparagus", "asparagus"],
  ["celery", "celery"],
  ["carrots?", "carrot"],
  ["garlic", "garlic"],
  ["spinach", "spinach"],
  ["cilantro", "cilantro"],
  ["ginger", "ginger"],
  ["clementines?", "clementine"],
];

/**
 * Kinds whose variety is commercially material: variety is required and must
 * come from this table. [pattern, canonical variety]
 */
export const VARIETY_REQUIRED: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  apple: [
    ["cosmic crisp", "cosmic crisp"], ["pink lady", "pink lady"], ["cripps pink", "cripps pink"],
    ["golden delicious", "golden delicious"], ["red delicious", "red delicious"],
    ["granny smith", "granny smith"], ["honey ?crisp", "honeycrisp"], ["autumn glory", "autumn glory"],
    ["ambrosia", "ambrosia"], ["braeburn", "braeburn"], ["envy", "envy"], ["evercrisp", "evercrisp"],
    ["fuji", "fuji"], ["gala", "gala"], ["jazz", "jazz"], ["jonagold", "jonagold"], ["juici", "juici"],
    ["kanzi", "kanzi"], ["koru", "koru"], ["lucy", "lucy"], ["mcintosh", "mcintosh"], ["opal", "opal"],
    ["pinata", "pinata"], ["rave", "rave"], ["smitten", "smitten"], ["snapdragon", "snapdragon"],
    ["sugarbee", "sugarbee"], ["sweetango", "sweetango"],
  ],
  pear: [
    ["red anjou", "red anjou"], ["green anjou", "green anjou"], ["d anjou|anjou", "anjou"],
    ["red bartlett", "red bartlett"], ["bartlett", "bartlett"], ["bosc", "bosc"], ["comice", "comice"],
    ["asian", "asian"], ["seckel", "seckel"], ["forelle", "forelle"], ["concorde", "concorde"],
    ["starkrimson", "starkrimson"],
  ],
  grape: [
    ["(red|green|black) seedless", "$1 seedless"], ["cotton candy", "cotton candy"],
    ["moon drops?", "moon drop"], ["autumn royal", "autumn royal"], ["concord", "concord"],
    ["red|green|black", "$0"],
  ],
  potato: [
    ["yukon gold", "yukon gold"], ["russet", "russet"], ["fingerling", "fingerling"],
    ["red|gold|yellow|white|purple", "$0"],
  ],
  onion: [
    ["walla walla(?: sweet)?", "walla walla"], ["vidalia", "vidalia"], ["maui", "maui"],
    ["pearl", "pearl"], ["cipollini", "cipollini"], ["yellow|white|red|sweet", "$0"],
  ],
  pepper: [
    ["mini sweet|sweet mini", "mini sweet"], ["jalapenos?", "jalapeno"], ["serrano", "serrano"],
    ["poblano", "poblano"], ["anaheim", "anaheim"], ["habanero", "habanero"], ["shishito", "shishito"],
  ],
  mushroom: [
    ["king oyster", "king oyster"], ["baby bella|cremini|crimini|brown", "cremini"],
    ["portobello|portabella|portabello", "portobello"], ["white(?: button)?", "white"],
    ["shiitake", "shiitake"], ["oyster", "oyster"], ["enoki", "enoki"], ["maitake", "maitake"],
    ["chanterelle", "chanterelle"],
  ],
  tomato: [
    ["on the vine|vine ripe(?:ned)?|tov", "on the vine"], ["roma", "roma"], ["heirloom", "heirloom"],
    ["beefsteak", "beefsteak"], ["campari", "campari"], ["cocktail", "cocktail"],
  ],
  orange: [["cara cara", "cara cara"], ["navel", "navel"], ["valencia", "valencia"], ["blood", "blood"]],
  lettuce: [["green leaf", "green leaf"], ["red leaf", "red leaf"], ["butter(?:head)?|bibb|boston", "butter"]],
  cabbage: [["napa", "napa"], ["savoy", "savoy"], ["green|red", "$0"]],
  squash: [
    ["butternut", "butternut"], ["acorn", "acorn"], ["spaghetti", "spaghetti"], ["delicata", "delicata"],
    ["kabocha", "kabocha"], ["yellow", "yellow"], ["summer", "summer"],
  ],
  cucumber: [["english", "english"], ["hothouse", "hothouse"], ["persian", "persian"], ["mini", "mini"]],
  avocado: [["hass", "hass"]],
  cherry: [["rainier", "rainier"], ["bing", "bing"], ["dark sweet", "dark sweet"], ["red", "red"]],
  peach: [["donut|saturn", "donut"], ["yellow|white", "$0"]],
  nectarine: [["yellow|white", "$0"]],
  plum: [["red|black", "$0"]],
  watermelon: [["mini seedless|personal", "mini seedless"], ["seedless", "seedless"], ["seeded", "seeded"]],
  "sweet potato": [["garnet", "garnet"], ["jewel", "jewel"], ["japanese", "japanese"], ["hannah", "hannah"]],
  corn: [["bi ?color", "bi-color"], ["yellow|white", "$0"]],
  kale: [["lacinato|dinosaur|tuscan", "lacinato"], ["curly", "curly"], ["red", "red"]],
  mango: [["ataulfo|honey", "ataulfo"], ["tommy atkins", "tommy atkins"], ["kent", "kent"], ["keitt", "keitt"]],
  kiwi: [["gold|sungold", "gold"], ["green", "green"]],
  grapefruit: [["ruby red", "ruby red"], ["star ruby", "star ruby"], ["red|white|pink", "$0"]],
};

/** Kinds where variety does not apply in M1 (documented not-applicable rule). */
export const VARIETY_NOT_APPLICABLE: ReadonlySet<string> = new Set([
  "strawberry", "raspberry", "blackberry", "blueberry", "broccoli", "cauliflower", "lemon", "lime",
  "banana", "cantaloupe", "honeydew", "pineapple", "asparagus", "celery", "carrot", "zucchini",
  "garlic", "spinach", "cilantro", "ginger", "clementine", "green onion", "green bean",
  "brussels sprout", "meyer lemon", "key lime",
]);

/**
 * Form qualifiers. "whole" applies when the kind is named without any
 * qualifier; two different qualifiers make form unknown.
 */
const FORM_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["fresh cut", "cut"],
  ["sliced|slices", "sliced"],
  ["diced|cubed|cubes", "diced"],
  ["chopped", "chopped"],
  ["peeled", "peeled"],
  ["shredded|matchsticks?|julienned?", "shredded"],
  ["riced|rice", "riced"],
  ["florets?", "florets"],
  ["spiralized|noodles|zoodles", "spiralized"],
  ["baby", "baby"],
  ["crowns?", "crowns"],
  ["hearts?", "hearts"],
  ["tips", "tips"],
  ["chunks|spears|halves|halved|wedges|strips|sticks|steaks|cut|trimmed|cored", "cut"],
  ["whole", "whole"],
];

// Organic: true only from explicit text ("organic", "O Organics", "Simple
// Truth Organic"); false only from explicit conventional/non-organic text.
const NOT_ORGANIC = /\b(?:non ?organic|not organic|conventional(?:ly grown)?)\b/;
const ORGANIC = /\borganics?\b/;

// ---------------------------------------------------------------------------
// Documented meat rules (R4)
// ---------------------------------------------------------------------------

export const MEAT_SPECIES: ReadonlyArray<readonly [string, string]> = [
  ["beef", "beef"], ["pork", "pork"], ["chickens?", "chicken"], ["turkeys?", "turkey"], ["lamb", "lamb"],
];
/** Skin applies to poultry only; it is not-applicable for beef, pork and lamb. */
export const POULTRY: ReadonlySet<string> = new Set(["chicken", "turkey"]);

/**
 * Cut vocabulary, most specific first. Specific cuts identify meat even
 * without a species word; generic ones ("steak", "roast", "ground") do not.
 * [pattern, canonical cut, specific]
 */
const CUT_PHRASES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["ground chuck", "ground chuck", true],
  ["ground round", "ground round", true],
  ["ground sirloin", "ground sirloin", true],
  ["ground (?:turkey |chicken )?breast", "ground breast", true],
  ["ground (?:beef|pork|turkey|chicken|lamb)", "ground", true],
  ["ground", "ground", false],
  ["chuck eye steaks?", "chuck eye steak", true],
  ["chuck (?:pot )?roasts?", "chuck roast", true],
  ["chuck steaks?", "chuck steak", true],
  ["top sirloin steaks?", "top sirloin steak", true],
  ["sirloin tip steaks?", "sirloin tip steak", true],
  ["sirloin tip roasts?", "sirloin tip roast", true],
  ["sirloin steaks?", "sirloin steak", true],
  ["sirloin chops?", "sirloin chop", true],
  ["tri tip(?: roasts?| steaks?)?", "tri-tip", true],
  ["rib ?eye steaks?", "ribeye steak", true],
  ["rib ?eye roasts?", "ribeye roast", true],
  ["rib ?eyes?", "ribeye", true],
  ["(?:standing )?rib roasts?|prime rib", "rib roast", true],
  ["(?:new york|ny) strip steaks?|(?:new york|ny) steaks?|strip loin steaks?|strip steaks?", "strip steak", true],
  ["t bone steaks?", "t-bone steak", true],
  ["porterhouse steaks?", "porterhouse steak", true],
  ["filet mignon|tenderloin steaks?", "tenderloin steak", true],
  ["tenderloin roasts?", "tenderloin roast", true],
  ["flank steaks?", "flank steak", true],
  ["skirt steaks?", "skirt steak", true],
  ["flat iron steaks?", "flat iron steak", true],
  ["hanger steaks?", "hanger steak", true],
  ["cube steaks?", "cube steak", true],
  ["top round steaks?", "top round steak", true],
  ["top round roasts?", "top round roast", true],
  ["bottom round roasts?", "bottom round roast", true],
  ["eye of round(?: roasts?| steaks?)?", "eye of round", true],
  ["round steaks?", "round steak", true],
  ["rump roasts?", "rump roast", true],
  ["london broil", "london broil", true],
  ["brisket", "brisket", true],
  ["short ribs?", "short ribs", true],
  ["stew meat|stew beef", "stew meat", true],
  ["oxtails?", "oxtail", true],
  ["baby back ribs?", "baby back ribs", true],
  ["spare ?ribs?", "spareribs", true],
  ["country style ribs?", "country-style ribs", true],
  ["back ribs?", "back ribs", true],
  ["center cut loin chops?", "center cut loin chop", true],
  ["loin chops?", "loin chop", true],
  ["rib chops?", "rib chop", true],
  ["blade chops?", "blade chop", true],
  ["loin roasts?", "loin roast", true],
  ["breast tenderloins?", "tenderloin", true],
  ["tenderloins?", "tenderloin", true],
  ["boston butt|pork butt|shoulder butt|butt roasts?", "shoulder butt", true],
  ["picnic(?: shoulder| roasts?)?", "picnic shoulder", true],
  ["shoulder roasts?", "shoulder roast", true],
  ["shoulder steaks?", "shoulder steak", true],
  ["leg of lamb", "leg", true],
  ["rack of lamb", "rack", true],
  ["split breasts?", "split breast", true],
  ["thin (?:cut|sliced) breasts?", "thin-cut breast", true],
  ["leg quarters?", "leg quarter", true],
  ["party wings?", "party wing", true],
  ["whole (?:fryers?|chickens?|turkeys?|birds?)|fryers?", "whole", true],
  ["drumsticks?", "drumstick", true],
  ["drumettes?", "drumette", true],
  ["thighs?", "thigh", true],
  ["breasts?", "breast", false],
  ["wings?", "wing", false],
  ["tenders", "tenders", false],
  ["cutlets?", "cutlet", false],
  ["legs?", "leg", false],
  ["racks?", "rack", false],
  ["shanks?", "shank", false],
  ["shoulder", "shoulder", false],
  ["belly", "belly", false],
  ["loin", "loin", false],
  ["chops?", "chop", false],
  ["steaks?", "steak", false],
  ["roasts?", "roast", false],
  ["ribs?", "ribs", false],
];

// ---------------------------------------------------------------------------
// R2 exclusions: explicit reasons, never guessed categories.
// ---------------------------------------------------------------------------

const EXCLUSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:fish|salmon|cod|halibut|tilapia|tuna|trout|pollock|catfish|rockfish|snapper|swordfish|mahi|sole|flounder|shrimp|prawns?|crabs?|lobsters?|scallops?|clams?|mussels?|oysters?(?! mushrooms?)|seafood|calamari|squid|octopus|anchov(?:y|ies)|sardines?|caviar|crawfish|surimi)\b/,
    "seafood (the M1 contract has no wild/farmed discriminator)"],
  [/\b(?:bacon|hams?|sausages?|bratwursts?|brats|kielbasa|chorizo|salami|pepperoni|prosciutto|pastrami|corned|bologna|hot dogs?|franks?|frankfurters?|wieners?|jerky|lunch ?meats?|deli|cold cuts|patty|patties|burgers?|hamburgers?|meatballs?|smoked|cured|nuggets?|hot links?|enhanced|solution)\b/,
    "cured or processed meat"],
  [/\b(?:veal|bison|buffalo|duck|goose|goat|venison|elk|rabbit|quail|game hens?|cornish hens?)\b/,
    "meat species outside M1 scope"],
  [/\b(?:rotisserie|cooked|precooked|roasted|fried|grilled|breaded|marinated|seasoned|stuffed|ready to (?:eat|cook|heat)|kabobs?|kebabs?|entrees?|sandwich(?:es)?|pizzas?|soups?|salsas?|guacamole|hummus|pies?|sushi|slaw|coleslaw|salads?)\b/,
    "prepared food"],
  [/\b(?:juices?|lemonade|smoothies?|cider|kombucha)\b/, "juice or beverage"],
  [/\b(?:cheeses?|breads?|crackers?|cereals?|flakes|yogurts?|ice cream|cream|cookies?|candy|chocolates?|sodas?|wines?|beers?|coffee|teas?|oils?|vinegars?|dressings?|flour|sugar|milk|cakes?|muffins?|pasta|tortillas?|pretzels?|granola|popcorn|peanut butter|spreads?|syrups?|eggs?|nuts|almonds|walnuts|pecans|cashews|pistachios|peanuts)\b/,
    "non-produce grocery item"],
  [/\b(?:kits?|bowls?|trays?|platters?|medley|blend|mix)\b/, "kit, bowl, tray or mixed produce"],
  [/\b(?:canned|jarred|dried|dehydrated|raisins|prunes|applesauce|sauce|puree|in syrup|pickled|pickles|jams?|jelly|jellies|preserves|chips|snacks?|fruit cups?)\b/,
    "canned or dried produce"],
];

const MIX_AND_MATCH = /\bmix (?:and|&) match\b/g;
// "Assorted", "select varieties" and similar mean more than one product.
const ASSORTMENT = /\b(?:assorted|assortment|variet(?:y|ies)|mixed)\b/;
const ALTERNATION = /\bor\b|&|\+|\band\b|(?<=[a-z])\s*\/\s*(?=[a-z])/;
const SEGMENT_SPLIT = /,|;|\bor\b|&|\+|\band\b|(?<=[a-z])\s*\/\s*(?=[a-z])/;
// Words that carry no identity of their own; used to decide whether an
// alternative segment only modifies a head named elsewhere.
const FILLER = /\b(?:and|or|the|of|a|with|fresh|whole|large|small|medium|jumbo|extra|mini|family|value|pack|size|premium|select|all|natural|usda|choice|prime|grade|local|locally|grown|ripe|sweet|seedless|thin|style|center|lean|fat|boneless|skinless|bone|in|skin|on|frozen|previously|never|organic|organics|conventional|non|lb|lbs|oz|pkg|package|ea|each|per|ct|count|red|green|yellow|orange|white|black|purple|gold|golden|pink)\b/g;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[®™©]/g, " ")
    .replace(/[’'`]/g, " ")
    .replace(/(?<=[a-z])-(?=[a-z])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const regexCache = new Map<string, RegExp>();
function wordRegex(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (!regex) {
    regex = new RegExp(`\\b(?:${pattern})\\b`, "g");
    regexCache.set(pattern, regex);
  }
  regex.lastIndex = 0;
  return regex;
}

function expand(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(\d)/g, (_, index: string) => match[Number(index)] ?? "");
}

/** Finds phrases in table order, blanking each match so shorter phrases cannot re-match it. */
function take<T>(text: string, table: ReadonlyArray<readonly [string, T]>, value: (entry: T, match: RegExpExecArray) => string):
  { values: string[]; rest: string } {
  const values: string[] = [];
  let rest = text;
  for (const [pattern, entry] of table) {
    const regex = wordRegex(pattern);
    rest = rest.replace(regex, (...args: unknown[]) => {
      const matched = args[0] as string;
      const groups = args.slice(0, -2).map((part) => (typeof part === "string" ? part : undefined));
      const exec = Object.assign([...groups], { index: 0, input: rest }) as unknown as RegExpExecArray;
      values.push(value(entry, exec));
      return " ".repeat(matched.length);
    });
  }
  return { values, rest };
}

function kindsIn(text: string): { kinds: string[]; implied: Array<[string, string]>; rest: string } {
  const implied: Array<[string, string]> = [];
  const table = KIND_PHRASES.map(([pattern, kind, variety]) => [pattern, { kind, variety }] as const);
  const { values, rest } = take(text, table, ({ kind, variety }, match) => {
    if (variety) implied.push([kind, expand(variety, match)]);
    return kind;
  });
  return { kinds: values, implied, rest };
}

function varietiesIn(text: string, kind: string): string[] {
  const { implied, rest } = kindsIn(text);
  const found = take(rest, VARIETY_REQUIRED[kind] ?? [], expand).values;
  return [...implied.filter(([k]) => k === kind).map(([, v]) => v), ...found];
}

function allVarietyTables(): ReadonlyArray<readonly [string, string]> {
  return Object.values(VARIETY_REQUIRED).flat();
}

function speciesIn(text: string): string[] {
  return take(text, MEAT_SPECIES, (species) => species).values;
}

function cutsIn(text: string): { cuts: string[]; specific: boolean } {
  let specific = false;
  const table = CUT_PHRASES.map(([pattern, cut, isSpecific]) => [pattern, { cut, isSpecific }] as const);
  const cuts = take(text, table, ({ cut, isSpecific }) => {
    specific ||= isSpecific;
    return cut;
  }).values;
  return { cuts, specific };
}

/** True when a segment holds only recognized vocabulary (a modifier of a head named elsewhere). */
function isPure(segment: string): boolean {
  let rest = kindsIn(segment).rest;
  rest = take(rest, allVarietyTables(), () => "").rest;
  rest = take(rest, FORM_PHRASES, () => "").rest;
  rest = take(rest, MEAT_SPECIES, () => "").rest;
  rest = take(rest, CUT_PHRASES.map(([pattern]) => [pattern, ""] as const), () => "").rest;
  rest = rest.replace(FILLER, " ");
  return !/[a-z]/.test(rest);
}

function segmentsOf(name: string): string[] {
  const text = normalizeText(name).replace(MIX_AND_MATCH, " ");
  if (!ALTERNATION.test(text)) return [text];
  return text.split(SEGMENT_SPLIT).map((part) => part.trim()).filter((part) => /[a-z0-9]/.test(part));
}

const known = <T>(value: T): Known<T> => ({ state: "known", value });
const UNKNOWN = { state: "unknown" } as const;
const NOT_APPLICABLE = { state: "not-applicable" } as const;

function single<T>(values: Iterable<T>): Known<T> {
  const distinct = new Set(values);
  return distinct.size === 1 ? known([...distinct][0] as T) : UNKNOWN;
}

/**
 * R3: resolves a required field across named alternatives. With one segment
 * the distinct values must agree. With several, every segment must name a
 * value (or, when `allowModifiers`, consist only of recognized modifiers) and
 * all named values must agree; otherwise the field is unknown.
 */
function acrossSegments(segments: string[], extract: (segment: string) => string[], allowModifiers: boolean): Known<string> {
  if (segments.length === 1) return single(extract(segments[0] ?? ""));
  const all: string[] = [];
  for (const segment of segments) {
    const values = extract(segment);
    if (values.length === 0 && !(allowModifiers && isPure(segment))) return UNKNOWN;
    all.push(...values);
  }
  return single(all);
}

// ---------------------------------------------------------------------------
// Classification (R2)
// ---------------------------------------------------------------------------

export function classifyText(name: string, description?: string | null): ItemCategory {
  const nameText = normalizeText(name);
  if (!/[a-z]/.test(nameText)) return { category: "excluded", reason: "missing or empty name" };
  const fullText = normalizeText(`${name} ${description ?? ""}`).replace(MIX_AND_MATCH, " ");
  for (const [pattern, reason] of EXCLUSIONS) {
    if (pattern.test(fullText)) return { category: "excluded", reason };
  }
  const produce = kindsIn(nameText).kinds.length > 0;
  // Meat needs a documented cut: a species word alone ("chicken broth") is not a raw cut.
  const cuts = cutsIn(nameText);
  const meat = cuts.specific || (cuts.cuts.length > 0 && speciesIn(nameText).length > 0);
  if (produce && meat) return { category: "excluded", reason: "names both produce and meat (mixed or prepared item)" };
  if (produce) {
    if (/\bfrozen\b/.test(fullText)) return { category: "excluded", reason: "frozen produce" };
    return { category: "produce", reason: null };
  }
  if (meat) return { category: "meat", reason: null };
  return { category: "excluded", reason: "unrecognized item: no documented produce kind or meat species/cut" };
}

// ---------------------------------------------------------------------------
// Identity derivation (R3, R4)
// ---------------------------------------------------------------------------

function organicOf(text: string): Known<boolean> {
  const negative = NOT_ORGANIC.test(text);
  const positive = ORGANIC.test(text.replace(new RegExp(NOT_ORGANIC.source, "g"), " "));
  if (positive && negative) return UNKNOWN;
  if (positive) return known(true);
  if (negative) return known(false);
  return UNKNOWN;
}

function formOf(text: string): Known<string> {
  let rest = kindsIn(text).rest;
  rest = take(rest, allVarietyTables(), () => "").rest;
  const forms = take(rest, FORM_PHRASES, (form) => form).values;
  if (forms.length === 0) return known("whole");
  return single(forms);
}

function freshFrozenOf(text: string): Known<"fresh" | "frozen"> {
  const values: Array<"fresh" | "frozen"> = [];
  let rest = text;
  rest = rest.replace(/\b(?:never|not) frozen\b/g, () => { values.push("fresh"); return " "; });
  rest = rest.replace(/\bpreviously frozen\b/g, () => { values.push("frozen"); return " "; });
  if (/\bfrozen\b/.test(rest)) values.push("frozen");
  if (/\bfresh\b/.test(rest)) values.push("fresh");
  return single(values);
}

function boneOf(text: string): Known<"in" | "out"> {
  const values: Array<"in" | "out"> = [];
  if (/\bboneless\b/.test(text)) values.push("out");
  if (/\bbone in\b/.test(text)) values.push("in");
  return single(values);
}

function skinOf(text: string): Known<"on" | "off"> {
  const values: Array<"on" | "off"> = [];
  if (/\bskinless\b/.test(text)) values.push("off");
  if (/\bskin on\b/.test(text)) values.push("on");
  return single(values);
}

/**
 * Ground-meat fat percentage: "93% lean" gives 7, "7% fat" gives 7, "80/20"
 * gives 20, and a single bare 50-99% value in text that also says "lean" is
 * the lean percentage. Discount percentages are ignored; any other bare
 * percentage or disagreement makes it unknown.
 */
function fatOf(text: string): Known<number> {
  const cleaned = text
    .replace(/\b\d{1,3} ?% off\b/g, " ")
    .replace(/\bsave (?:up to )?\d{1,3} ?%/g, " ");
  const values: number[] = [];
  for (const match of cleaned.matchAll(/\b(\d{2}) ?\/ ?(\d{1,2})\b/g)) {
    const lean = Number(match[1]);
    const fat = Number(match[2]);
    if (lean >= 50 && lean <= 99 && lean + fat === 100) values.push(fat);
  }
  const saysLean = /\blean\b/.test(cleaned);
  for (const match of cleaned.matchAll(/\b(\d{1,3}(?:\.\d+)?) ?%(?: (lean|fat)\b)?/g)) {
    const value = Number(match[1]);
    if (!Number.isInteger(value)) return UNKNOWN;
    if (match[2] === "lean" && value >= 50 && value <= 99) values.push(100 - value);
    else if (match[2] === "fat" && value >= 1 && value <= 50) values.push(value);
    else if (match[2] === undefined && saysLean && value >= 50 && value <= 99) values.push(100 - value);
    else return UNKNOWN;
  }
  return single(values);
}

function isGroundCut(cut: string): boolean {
  return cut === "ground" || cut.startsWith("ground ");
}

/**
 * Derives the identity of an item already classified as produce or meat.
 * Kind/species/cut/variety come from the name (with R3 alternatives);
 * qualifiers come from the name plus description.
 */
export function deriveIdentity(category: "produce" | "meat", name: string, description?: string | null): Identity {
  const segments = segmentsOf(name);
  const fullText = normalizeText(`${name} ${description ?? ""}`).replace(MIX_AND_MATCH, " ");
  const assorted = ASSORTMENT.test(fullText) || /\bmix (?:and|&) match\b/.test(normalizeText(`${name} ${description ?? ""}`));

  if (category === "produce") {
    const kind = acrossSegments(segments, (segment) => kindsIn(segment).kinds, true);
    let variety: Known<string> = UNKNOWN;
    if (kind.state === "known") {
      if (VARIETY_NOT_APPLICABLE.has(kind.value)) variety = NOT_APPLICABLE;
      else if (!assorted) variety = acrossSegments(segments, (segment) => varietiesIn(segment, kind.value), false);
    }
    return { category, kind, variety, form: formOf(fullText), organic: organicOf(fullText) };
  }

  const species = acrossSegments(segments, speciesIn, true);
  const cut = assorted ? UNKNOWN : acrossSegments(segments, (segment) => cutsIn(segment).cuts, true);
  const ground = cut.state === "known" && isGroundCut(cut.value);
  const bone = ground ? NOT_APPLICABLE : boneOf(fullText);
  const skin = species.state !== "known" ? UNKNOWN : POULTRY.has(species.value) ? skinOf(fullText) : NOT_APPLICABLE;
  const fatPercent = cut.state !== "known" ? UNKNOWN : ground ? fatOf(fullText) : NOT_APPLICABLE;
  return { category, species, cut, bone, skin, freshFrozen: freshFrozenOf(fullText), fatPercent };
}

// ---------------------------------------------------------------------------
// Comparison key (R4): null whenever a required field is unknown or a value
// contradicts the documented rules above.
// ---------------------------------------------------------------------------

const KNOWN_KINDS: ReadonlySet<string> = new Set(KIND_PHRASES.map(([, kind]) => kind));
const KNOWN_SPECIES: ReadonlySet<string> = new Set(MEAT_SPECIES.map(([, species]) => species));

function isKnownString(value: Known<string>): value is { state: "known"; value: string } {
  return value.state === "known" && typeof value.value === "string" && value.value.length > 0;
}

/** Lists fields that are unknown or violate the documented rules. */
export function identityGaps(identity: Identity): string[] {
  const gaps: string[] = [];
  if (identity.category === "produce") {
    const kind = identity.kind;
    if (!isKnownString(kind) || !KNOWN_KINDS.has(kind.value)) gaps.push("kind");
    if (isKnownString(kind) && VARIETY_NOT_APPLICABLE.has(kind.value)) {
      if (identity.variety.state !== "not-applicable") gaps.push("variety");
    } else if (!isKnownString(identity.variety)) {
      gaps.push("variety");
    }
    if (!isKnownString(identity.form)) gaps.push("form");
    if (identity.organic.state !== "known" || typeof identity.organic.value !== "boolean") gaps.push("organic");
    return gaps;
  }
  const species = identity.species;
  const speciesKnown = isKnownString(species) && KNOWN_SPECIES.has(species.value);
  if (!speciesKnown) gaps.push("species");
  const cutKnown = isKnownString(identity.cut);
  if (!cutKnown) gaps.push("cut");
  const ground = cutKnown && isGroundCut((identity.cut as { value: string }).value);
  if (!cutKnown || (ground ? identity.bone.state !== "not-applicable" : identity.bone.state !== "known")) gaps.push("bone");
  const poultry = speciesKnown && POULTRY.has((species as { value: string }).value);
  if (!speciesKnown || (poultry ? identity.skin.state !== "known" : identity.skin.state !== "not-applicable")) gaps.push("skin");
  if (identity.freshFrozen.state !== "known") gaps.push("freshFrozen");
  const fat = identity.fatPercent;
  const fatValid = fat.state === "known" && Number.isInteger(fat.value) && fat.value >= 0 && fat.value <= 100;
  if (!cutKnown || (ground ? !fatValid : fat.state !== "not-applicable")) gaps.push("fatPercent");
  return gaps;
}

function part(name: string, value: Known<unknown>): string {
  const text = value.state === "known" ? String(value.value) : "n/a";
  return `${name}=${encodeURIComponent(text)}`;
}

/** Comparable-identity key shared by the proof gate and later comparison. */
export function comparisonKey(identity: Identity): string | null {
  if (identityGaps(identity).length > 0) return null;
  if (identity.category === "produce") {
    return ["produce", part("kind", identity.kind), part("variety", identity.variety),
      part("form", identity.form), part("organic", identity.organic)].join("|");
  }
  return ["meat", part("species", identity.species), part("cut", identity.cut), part("bone", identity.bone),
    part("skin", identity.skin), part("freshFrozen", identity.freshFrozen), part("fat", identity.fatPercent)].join("|");
}
