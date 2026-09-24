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
  ["cantaloupes?(?: melons?)?", "cantaloupe"],
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
  ["kiwifruit|kiwi fruit|kiwis?", "kiwi"],
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
  // F2: celery root (celeriac) is a different vegetable. It has no variety
  // rule, so its variety stays unknown and it never keys.
  ["celery roots?|celeriac", "celery root"],
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
    // A4: loose vine-ripe tomatoes are a different product from tomatoes on the vine.
    ["on the vine|tov", "on the vine"], ["vine ripe(?:ned)?", "vine ripe"], ["roma", "roma"], ["heirloom", "heirloom"],
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
 * qualifier; two different qualifiers make form unknown. "Peeled baby" is one
 * documented combination with its own form, distinct from plain "baby".
 */
const FORM_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["peeled baby|baby peeled", "baby-peeled"],
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
// A1: negated or exclusionary wording near "organic" makes it unknown, both
// before it ("excludes organic", "excl. organic", "except organic", "not
// including organic", "not organic") and after it ("organic excluded",
// "organic not included", "organic not eligible", "organics excepted").
const NOT_ORGANIC = /\b(?:non ?organic|conventional(?:ly grown)?)\b/;
const NOT_ORGANIC_ALL = new RegExp(NOT_ORGANIC.source, "g");
const ORGANIC = /\borganics?\b/;
const NEGATION_GAP = "(?:[^a-z0-9]+[a-z0-9]+){0,3}?[^a-z0-9]+";
const NEGATION_BEFORE = "exclud(?:e|es|ed|ing)|excl|except(?:ing)?|not(?: including| incl)?|no|without|other than";
const NEGATION_AFTER = "exclud(?:ed|es|ing)|excl|except(?:ed)?|not (?:included|including|incl|eligible)|ineligible";
const ORGANIC_NEGATION_SOURCE =
  `\\b(?:${NEGATION_BEFORE})\\b${NEGATION_GAP}organics?\\b|\\borganics?\\b${NEGATION_GAP}(?:${NEGATION_AFTER})\\b`;
const ORGANIC_NEGATION = new RegExp(ORGANIC_NEGATION_SOURCE);
const ORGANIC_NEGATION_ALL = new RegExp(ORGANIC_NEGATION_SOURCE, "g");

/**
 * A2: processed produce forms. Produce naming any of these is excluded; it
 * never defaults to form "whole". "Ground" here is the spice ("ground
 * ginger"); ground meat is classified as meat before this applies.
 */
const PROCESSED_PRODUCE = /\b(?:powder(?:ed)?|minced|grated|crushed|ground|pastes?|purees?|pureed|flakes?|seasonings?|dips?|sauces?|waters?|drinks?)\b/;

/**
 * A2 head-noun rule: size/unit tokens and whole-produce unit nouns that may
 * follow the produce kind at the end of a name (besides form qualifiers,
 * variety words and filler). F2: "stalk" is not one of them, because
 * "Brussels Sprouts on the Stalk" is not loose Brussels sprouts; a trailing
 * "stalk" therefore excludes the item (this also excludes "Celery Stalks").
 */
const HEAD_TRAILERS = /\b(?:oz|ounces?|lbs?|pounds?|kg|g|grams?|ct|count|pk|packs?|package|pkg|bags?|bunch(?:es)?|pints?|quarts?|clamshells?|containers?|baskets?|box(?:es)?|each|ea|per|sold|by|ears?|cobs?|heads?|roots?|bulbs?|variet(?:y|ies)|assorted|assortment|mixed)\b/g;

// ---------------------------------------------------------------------------
// Documented meat rules (R4)
// ---------------------------------------------------------------------------

export const MEAT_SPECIES: ReadonlyArray<readonly [string, string]> = [
  ["beef", "beef"], ["pork", "pork"], ["chickens?", "chicken"], ["turkeys?", "turkey"], ["lamb", "lamb"],
];
/**
 * Skin applies to non-ground poultry only; it is not-applicable for beef, pork
 * and lamb, and for ground meat of any species (R4, amended 2026-09-24).
 */
export const POULTRY: ReadonlySet<string> = new Set(["chicken", "turkey"]);

/**
 * A3: meat production claims the M1 identity contract has no discriminator
 * for. Such meat is excluded, including "organically raised/grown". USDA
 * Choice/Select and Angus are a documented known limitation
 * (DEC-20260924-003) and are not excluded here.
 */
const MEAT_PRODUCTION_CLAIM = /\b(?:organic(?:s|ally)?|grass ?(?:fed|finished)|pasture (?:raised|fed)|free range|wagyu|kobe|usda prime)\b/;

/** A4: a cut phrase that cannot tell roast from steak; the cut stays unknown. */
const AMBIGUOUS_CUT = "?";

/**
 * A4: preparation qualifiers. Unless a cut phrase maps one to a distinct cut
 * (for example "thin cut breasts"), a leftover qualifier in the name or any
 * qualifier in the description makes the cut unknown.
 */
const PREPARATION = /\b(?:thin(?:ly)? (?:cut|sliced)|thick (?:cut|sliced)|sliced|diced|cubed|butterfl(?:y|ied)|tenderized|flanken|st\.? louis|for (?:carne asada|stir fry|fajitas?|stew(?:ing)?|kabobs?|kebabs?|bulgogi|milanesa|stroganoff|philly|cheesesteaks?)|carne asada|stir fry|fajitas?|milanesa|bulgogi|korean (?:style|bbq))\b/;

/**
 * F1: cut-part and portion words. Left over after the cut phrases below have
 * matched, they name a different or smaller product than the matched cut
 * ("chuck eye roast", "breast strips", "bottom round steak"), so the cut
 * becomes unknown. A phrase that names such a cut ("top sirloin steak", "eye
 * of round roast") consumes these words first and stays a known cut. B4:
 * brisket point and deckle are sub-cuts of a brisket, and tomahawk and cowboy
 * name long- or frenched-bone rib steaks, never a plain ribeye.
 */
const CUT_RESIDUE = /\b(?:chuck|sirloin|round|rump|heel|eye|cross|arm|blade|bottom|top|tips?|tri|petite|flats?|flap|cap|center|ends?|inside|outside|thin|thick|frenched|strips?|slices?|cubes?|chunks?|pieces?|portions?|bites?|fillets?|filets?|medallions?|shaved|tenders?|halves|halved|half|split|sections?|drums?|backs?|necks?|cut up|point|deckle|tomahawk|cowboy)\b/;

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
  ["tri tip roasts?", "tri-tip roast", true],
  ["tri tip steaks?", "tri-tip steak", true],
  ["tri tips?", AMBIGUOUS_CUT, true],
  ["rib ?eye steaks?", "ribeye steak", true],
  ["rib ?eye roasts?", "ribeye roast", true],
  ["rib ?eyes?", AMBIGUOUS_CUT, true],
  // F1: the cross rib (chuck cross rib) roast is a chuck cut, not a rib roast.
  ["(?:chuck )?cross rib (?:pot )?roasts?", "cross rib roast", true],
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
  ["eye of round roasts?", "eye of round roast", true],
  ["eye of round steaks?", "eye of round steak", true],
  ["eye of round", AMBIGUOUS_CUT, true],
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
  ["drumm?ettes?", "drumette", true],
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
  // F1: these bare words name no primal or sub-primal, so they classify as
  // meat but never key. For chops, species plus bone state still does not
  // say which (pork: loin, rib, blade or sirloin; lamb: loin, rib or shoulder).
  ["chops?", AMBIGUOUS_CUT, false],
  ["steaks?", AMBIGUOUS_CUT, false],
  ["roasts?", AMBIGUOUS_CUT, false],
  ["ribs?", AMBIGUOUS_CUT, false],
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
    // Strip these before NFKD, which would turn "Envy™" into "EnvyTM".
    .replace(/[™℠©®]/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
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

/** Match text and capture groups: [match, ...groups], unmatched groups undefined. */
export type MatchGroups = ReadonlyArray<string | undefined>;

/**
 * Replaces every match of a global regex (without named groups) with what
 * `replace` returns for its groups and match offset.
 */
export function replaceEach(text: string, regex: RegExp, replace: (groups: MatchGroups, offset: number) => string): string {
  regex.lastIndex = 0;
  return text.replace(regex, (...args: unknown[]) => {
    const offset = args[args.length - 2];
    return replace(args.slice(0, -2).map((part) => (typeof part === "string" ? part : undefined)),
      typeof offset === "number" ? offset : 0);
  });
}

function expand(template: string, groups: MatchGroups): string {
  return template.replace(/\$(\d)/g, (_, index: string) => groups[Number(index)] ?? "");
}

/**
 * Finds phrases in table order, blanking each match so shorter phrases cannot
 * re-match it. `value` also gets the index just past the match.
 */
function take<T>(text: string, table: ReadonlyArray<readonly [string, T]>,
  value: (entry: T, groups: MatchGroups, end: number) => string): { values: string[]; rest: string } {
  const values: string[] = [];
  let rest = text;
  for (const [pattern, entry] of table) {
    rest = replaceEach(rest, wordRegex(pattern), (groups, offset) => {
      const match = groups[0] ?? "";
      values.push(value(entry, groups, offset + match.length));
      return " ".repeat(match.length);
    });
  }
  return { values, rest };
}

const KIND_TABLE = KIND_PHRASES.map(([pattern, kind, variety]) => [pattern, { kind, variety }] as const);
const CUT_TABLE = CUT_PHRASES.map(([pattern, cut, specific]) => [pattern, { cut, specific }] as const);
const ALL_VARIETIES: ReadonlyArray<readonly [string, string]> = Object.values(VARIETY_REQUIRED).flat();

interface KindMatch { kind: string; end: number }

/** Kinds in table order, their implied varieties, and the last kind in the text by position. */
function kindsIn(text: string): { kinds: string[]; implied: Array<[string, string]>; last: KindMatch | null; rest: string } {
  const implied: Array<[string, string]> = [];
  const matches: KindMatch[] = [];
  const { values, rest } = take(text, KIND_TABLE, ({ kind, variety }, groups, end) => {
    if (variety) implied.push([kind, expand(variety, groups)]);
    matches.push({ kind, end });
    return kind;
  });
  const last = matches.reduce<KindMatch | null>((latest, match) => (latest === null || match.end > latest.end ? match : latest), null);
  return { kinds: values, implied, last, rest };
}

function varietiesIn(text: string, kind: string): string[] {
  const { implied, rest } = kindsIn(text);
  const found = take(rest, VARIETY_REQUIRED[kind] ?? [], expand).values;
  return [...implied.filter(([k]) => k === kind).map(([, v]) => v), ...found];
}

function speciesIn(text: string): string[] {
  return take(text, MEAT_SPECIES, (species) => species).values;
}

function cutsIn(text: string): { cuts: string[]; specific: boolean; rest: string } {
  let specific = false;
  const { values, rest } = take(text, CUT_TABLE, ({ cut, specific: isSpecific }) => {
    specific ||= isSpecific;
    return cut;
  });
  return { cuts: values, specific, rest };
}

/**
 * Cuts named in one segment; a leftover preparation qualifier (A4) or
 * cut-part/portion word (F1) makes it ambiguous.
 */
function segmentCuts(segment: string): string[] {
  const { cuts, rest } = cutsIn(segment);
  return PREPARATION.test(rest) || CUT_RESIDUE.test(rest) ? [...cuts, AMBIGUOUS_CUT] : cuts;
}

/**
 * True when a segment holds only recognized vocabulary (a modifier of a head
 * named elsewhere). Variety words count only for `kind`, the kind the other
 * alternatives resolve to, so "Tuscan or Cantaloupe Melons" is not a
 * cantaloupe just because "tuscan" is a kale variety.
 */
function isPure(segment: string, kind: string | null): boolean {
  let rest = kindsIn(segment).rest;
  if (kind !== null) rest = take(rest, VARIETY_REQUIRED[kind] ?? [], () => "").rest;
  rest = take(rest, FORM_PHRASES, () => "").rest;
  rest = take(rest, MEAT_SPECIES, () => "").rest;
  rest = cutsIn(rest).rest;
  rest = rest.replace(FILLER, " ");
  return !/[a-z]/.test(rest);
}

/**
 * A2 head-noun rule for one name segment: after the last produce kind, only
 * form qualifiers, that kind's own variety words (N2), organic exclusion
 * wording (which already makes organic unknown), filler and size/unit tokens
 * may follow. Returns the offending trailing words, or null.
 */
function trailingAfterKind(segment: string): string | null {
  const { last } = kindsIn(segment);
  if (last === null) return null;
  let tail = segment.slice(last.end).replace(ORGANIC_NEGATION_ALL, " ");
  tail = take(tail, VARIETY_REQUIRED[last.kind] ?? [], () => "").rest;
  tail = take(tail, FORM_PHRASES, () => "").rest;
  tail = tail.replace(FILLER, " ").replace(HEAD_TRAILERS, " ");
  const leftover = tail.replace(/[^a-z]+/g, " ").trim();
  return leftover.length > 0 ? leftover : null;
}

/**
 * Name segments shared by classifyText and deriveIdentity: split at commas,
 * "or", "and", "&", "+" and "/" only when the name names alternatives;
 * otherwise the whole name is one segment.
 */
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
 * value (or satisfy `isModifier`, when given) and all named values must
 * agree; otherwise the field is unknown.
 */
function acrossSegments(segments: string[], extract: (segment: string) => string[],
  isModifier: ((segment: string) => boolean) | null): Known<string> {
  if (segments.length === 1) return single(extract(segments[0] ?? ""));
  const all: string[] = [];
  for (const segment of segments) {
    const values = extract(segment);
    if (values.length === 0 && !(isModifier?.(segment) ?? false)) return UNKNOWN;
    all.push(...values);
  }
  return single(all);
}

/**
 * A1: resolves a qualifier (organic, form, bone, skin, fresh/frozen) per name
 * segment. If any alternative states a value, every alternative must state
 * the same single value; otherwise it is unknown. Description values apply
 * to all alternatives and must agree with the name. When the name is silent,
 * the description sets the value only if `descriptionAlone`; with nothing
 * stated, `fallback` applies.
 */
function qualifier<T>(segments: string[], description: string, extract: (text: string) => T[],
  descriptionAlone: boolean, fallback: Known<T>): Known<T> {
  const stated: T[] = [];
  let silent = 0;
  for (const segment of segments) {
    const values = new Set(extract(segment));
    if (values.size > 1) return UNKNOWN;
    if (values.size === 0) silent += 1;
    else stated.push(...values);
  }
  const fromName = single(stated);
  if (stated.length > 0 && (silent > 0 || fromName.state !== "known")) return UNKNOWN;
  const described = extract(description);
  const fromDescription = single(described);
  if (described.length > 0 && fromDescription.state !== "known") return UNKNOWN;
  if (fromName.state === "known") {
    return fromDescription.state !== "known" || fromDescription.value === fromName.value ? fromName : UNKNOWN;
  }
  if (fromDescription.state === "known") return descriptionAlone ? fromDescription : UNKNOWN;
  return fallback;
}

// ---------------------------------------------------------------------------
// Classification (R2)
// ---------------------------------------------------------------------------

export function classifyText(name: string, description?: string | null): ItemCategory {
  const nameText = normalizeText(name);
  if (!/[a-z]/.test(nameText)) return { category: "excluded", reason: "missing or empty name" };
  const fullText = normalizeText(`${name} ${description ?? ""}`).replace(MIX_AND_MATCH, " ");
  // "Cotton candy" before "grapes" is a grape variety, not the candy exclusion.
  const exclusionText = fullText.replace(/\bcotton candy(?= grapes?\b)/g, " ");
  for (const [pattern, reason] of EXCLUSIONS) {
    if (pattern.test(exclusionText)) return { category: "excluded", reason };
  }
  const produce = kindsIn(nameText).kinds.length > 0;
  // Meat needs a documented cut: a species word alone ("chicken broth") is not a raw cut.
  const cuts = cutsIn(nameText);
  const meat = cuts.specific || (cuts.cuts.length > 0 && speciesIn(nameText).length > 0);
  if (produce && meat) return { category: "excluded", reason: "names both produce and meat (mixed or prepared item)" };
  if (produce) {
    if (/\bfrozen\b/.test(fullText)) return { category: "excluded", reason: "frozen produce" };
    const processed = PROCESSED_PRODUCE.exec(fullText);
    if (processed) return { category: "excluded", reason: `processed produce form "${processed[0]}"` };
    // F3: the same segments deriveIdentity uses, so a comma segment of a
    // single-product name ("Organic Garlic, Butter") is part of the tail.
    for (const segment of segmentsOf(name)) {
      const trailing = trailingAfterKind(segment);
      if (trailing !== null) {
        return { category: "excluded", reason: `unrecognized item: produce kind is not the head of the name (followed by "${trailing}")` };
      }
    }
    return { category: "produce", reason: null };
  }
  if (meat) {
    const claim = MEAT_PRODUCTION_CLAIM.exec(fullText);
    if (claim) return { category: "excluded", reason: `production claim not in M1 identity contract ("${claim[0]}")` };
    return { category: "meat", reason: null };
  }
  return { category: "excluded", reason: "unrecognized item: no documented produce kind or meat species/cut" };
}

// ---------------------------------------------------------------------------
// Identity derivation (R3, R4)
// ---------------------------------------------------------------------------

// Qualifier extractors: every value one text states (A1 resolves them).

function organicIn(text: string): boolean[] {
  const values: boolean[] = [];
  if (NOT_ORGANIC.test(text)) values.push(false);
  if (ORGANIC.test(text.replace(NOT_ORGANIC_ALL, " "))) values.push(true);
  return values;
}

function formsIn(text: string): string[] {
  let rest = kindsIn(text).rest;
  rest = take(rest, ALL_VARIETIES, () => "").rest;
  return take(rest, FORM_PHRASES, (form) => form).values;
}

function freshFrozenIn(text: string): Array<"fresh" | "frozen"> {
  const values: Array<"fresh" | "frozen"> = [];
  let rest = text;
  rest = rest.replace(/\b(?:never|not) frozen\b/g, () => { values.push("fresh"); return " "; });
  rest = rest.replace(/\bpreviously frozen\b/g, () => { values.push("frozen"); return " "; });
  if (/\bfrozen\b/.test(rest)) values.push("frozen");
  if (/\bfresh\b/.test(rest)) values.push("fresh");
  return values;
}

function bonesIn(text: string): Array<"in" | "out"> {
  const values: Array<"in" | "out"> = [];
  if (/\bboneless\b/.test(text)) values.push("out");
  if (/\bbone in\b/.test(text)) values.push("in");
  return values;
}

function skinsIn(text: string): Array<"on" | "off"> {
  const values: Array<"on" | "off"> = [];
  if (/\bskinless\b/.test(text)) values.push("off");
  if (/\bskin on\b/.test(text)) values.push("on");
  return values;
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
 * qualifiers are resolved per alternative, with the description applying to
 * all of them (A1).
 */
export function deriveIdentity(category: "produce" | "meat", name: string, description?: string | null): Identity {
  const segments = segmentsOf(name);
  const descriptionText = normalizeText(description ?? "").replace(MIX_AND_MATCH, " ");
  const fullText = normalizeText(`${name} ${description ?? ""}`).replace(MIX_AND_MATCH, " ");
  const assorted = ASSORTMENT.test(fullText) || /\bmix (?:and|&) match\b/.test(normalizeText(`${name} ${description ?? ""}`));

  if (category === "produce") {
    const named = single(segments.flatMap((segment) => kindsIn(segment).kinds));
    const headKind = named.state === "known" ? named.value : null;
    const kind = acrossSegments(segments, (segment) => kindsIn(segment).kinds, (segment) => isPure(segment, headKind));
    let variety: Known<string> = UNKNOWN;
    if (kind.state === "known") {
      if (VARIETY_NOT_APPLICABLE.has(kind.value)) variety = NOT_APPLICABLE;
      else if (!assorted) variety = acrossSegments(segments, (segment) => varietiesIn(segment, kind.value), null);
    }
    // A2: a processed form never defaults to whole.
    const form = PROCESSED_PRODUCE.test(fullText) ? UNKNOWN : qualifier(segments, descriptionText, formsIn, true, known("whole"));
    const organic = ORGANIC_NEGATION.test(fullText) ? UNKNOWN : qualifier(segments, descriptionText, organicIn, false, UNKNOWN);
    return { category, kind, variety, form, organic };
  }

  const modifier = (segment: string) => isPure(segment, null);
  const species = acrossSegments(segments, speciesIn, modifier);
  let cut = assorted ? UNKNOWN : acrossSegments(segments, segmentCuts, modifier);
  if ((cut.state === "known" && cut.value === AMBIGUOUS_CUT) || PREPARATION.test(descriptionText)) cut = UNKNOWN;
  const ground = cut.state === "known" && isGroundCut(cut.value);
  const bone = ground ? NOT_APPLICABLE : qualifier(segments, descriptionText, bonesIn, true, UNKNOWN);
  const poultry = species.state === "known" && POULTRY.has(species.value);
  const skin = ground ? NOT_APPLICABLE
    : species.state !== "known" ? UNKNOWN
    : poultry ? qualifier(segments, descriptionText, skinsIn, true, UNKNOWN) : NOT_APPLICABLE;
  const freshFrozen = qualifier(segments, descriptionText, freshFrozenIn, true, UNKNOWN);
  const fatPercent = cut.state !== "known" ? UNKNOWN : ground ? fatOf(fullText) : NOT_APPLICABLE;
  return { category, species, cut, bone, skin, freshFrozen, fatPercent };
}

// ---------------------------------------------------------------------------
// Comparison key (R4): null whenever a required field is unknown or a value
// contradicts the documented rules above.
// ---------------------------------------------------------------------------

const KNOWN_KINDS: ReadonlySet<string> = new Set(KIND_PHRASES.map(([, kind]) => kind));
const KNOWN_SPECIES: ReadonlySet<string> = new Set(MEAT_SPECIES.map(([, species]) => species));
const KNOWN_FORMS: ReadonlySet<string> = new Set(FORM_PHRASES.map(([, form]) => form));
const KNOWN_CUTS: ReadonlySet<string> = new Set(CUT_PHRASES.map(([, cut]) => cut).filter((cut) => cut !== AMBIGUOUS_CUT));

/**
 * Every value a vocabulary entry can yield. "$0" (the whole match) and "$1"
 * (the first group) must be plain word alternations such as "red|green".
 */
function templateValues(pattern: string, template: string): string[] {
  const slot = /\$(\d)/.exec(template);
  if (!slot) return [template];
  const source = slot[1] === "0" ? pattern : slot[1] === "1" ? /\(([^()]*)\)/.exec(pattern)?.[1] : undefined;
  if (source === undefined || !/^[a-z ]+(?:\|[a-z ]+)*$/.test(source)) {
    throw new Error(`identity vocabulary: cannot enumerate "${template}" for "${pattern}"`);
  }
  return source.split("|").map((alternative) => template.replace(slot[0], alternative));
}

/** Canonical varieties per kind: implied by a kind phrase or listed in VARIETY_REQUIRED. */
const KNOWN_VARIETIES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const varieties = new Map<string, Set<string>>();
  const add = (kind: string, pattern: string, template: string) => {
    const values = varieties.get(kind) ?? new Set<string>();
    for (const value of templateValues(pattern, template)) values.add(value);
    varieties.set(kind, values);
  };
  for (const [pattern, kind, variety] of KIND_PHRASES) if (variety !== undefined) add(kind, pattern, variety);
  for (const [kind, table] of Object.entries(VARIETY_REQUIRED)) for (const [pattern, variety] of table) add(kind, pattern, variety);
  return varieties;
})();

/**
 * F4: known and one of the documented vocabulary values. Anything else,
 * including an ill-formed string such as a lone surrogate, never keys.
 */
function isKnownIn(value: Known<unknown>, allowed: ReadonlySet<string> | undefined): value is { state: "known"; value: string } {
  return value.state === "known" && typeof value.value === "string" && allowed !== undefined && allowed.has(value.value);
}

/** Known and one of the documented enum values (A7: out-of-range values never key). */
function isKnownOneOf(value: Known<unknown>, allowed: readonly unknown[]): boolean {
  return value.state === "known" && allowed.includes(value.value);
}

/** Lists fields that are unknown or violate the documented rules. */
export function identityGaps(identity: Identity): string[] {
  const gaps: string[] = [];
  if (identity.category === "produce") {
    const kind = identity.kind;
    const kindKnown = isKnownIn(kind, KNOWN_KINDS);
    if (!kindKnown) gaps.push("kind");
    if (kindKnown && VARIETY_NOT_APPLICABLE.has(kind.value)) {
      if (identity.variety.state !== "not-applicable") gaps.push("variety");
    } else if (!(kindKnown && isKnownIn(identity.variety, KNOWN_VARIETIES.get(kind.value)))) {
      gaps.push("variety");
    }
    if (!isKnownIn(identity.form, KNOWN_FORMS)) gaps.push("form");
    if (identity.organic.state !== "known" || typeof identity.organic.value !== "boolean") gaps.push("organic");
    return gaps;
  }
  const species = identity.species;
  const speciesKnown = isKnownIn(species, KNOWN_SPECIES);
  if (!speciesKnown) gaps.push("species");
  const cut = identity.cut;
  const cutKnown = isKnownIn(cut, KNOWN_CUTS);
  if (!cutKnown) gaps.push("cut");
  const ground = cutKnown && isGroundCut(cut.value);
  if (!cutKnown || (ground ? identity.bone.state !== "not-applicable" : !isKnownOneOf(identity.bone, ["in", "out"]))) gaps.push("bone");
  // R4 (amended): known skin only for non-ground poultry; otherwise not-applicable.
  const skinApplies = speciesKnown && !ground && POULTRY.has((species as { value: string }).value);
  if (!speciesKnown || (skinApplies ? !isKnownOneOf(identity.skin, ["on", "off"]) : identity.skin.state !== "not-applicable")) gaps.push("skin");
  if (!isKnownOneOf(identity.freshFrozen, ["fresh", "frozen"])) gaps.push("freshFrozen");
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
