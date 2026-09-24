import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/shared/contracts.js";
import {
  classifyText,
  comparisonKey,
  deriveIdentity,
  identityGaps,
} from "../../src/shared/identity.js";

const known = <T>(value: T) => ({ state: "known" as const, value });
const na = { state: "not-applicable" as const };
const unknown = { state: "unknown" as const };

function produce(name: string, description?: string): Identity {
  expect(classifyText(name, description)).toEqual({ category: "produce", reason: null });
  return deriveIdentity("produce", name, description);
}

function meat(name: string, description?: string): Identity {
  expect(classifyText(name, description)).toEqual({ category: "meat", reason: null });
  return deriveIdentity("meat", name, description);
}

describe("category classification (R2)", () => {
  it.each([
    ["Atlantic Salmon Fillets", /seafood/],
    ["Wild Caught Shrimp", /seafood/],
    ["Hormel Black Label Bacon", /cured or processed/],
    ["Johnsonville Brats", /cured or processed/],
    ["Beef Patties", /cured or processed/],
    ["Ball Park Hot Dogs", /cured or processed/],
    ["Rotisserie Chicken", /prepared/],
    ["Marinated Pork Tenderloin", /prepared/],
    ["Taylor Farms Chopped Salad Kit", /kit|bowl|mix|prepared/],
    ["Tropicana Orange Juice", /juice/],
    ["Frozen Blueberries", /frozen produce/],
    ["Dried Mango", /canned or dried/],
    ["Canned Peaches", /canned or dried/],
    ["Bounty Paper Towels", /unrecognized/],
    ["Tillamook Cheddar Cheese", /non-produce/],
    ["", /unrecognized|missing/],
  ])("excludes %j with a reason", (name, reason) => {
    const result = classifyText(name);
    expect(result.category).toBe("excluded");
    expect(result.reason).toMatch(reason);
  });

  it("recognizes produce and meat from documented vocabulary", () => {
    expect(classifyText("Honeycrisp Apples").category).toBe("produce");
    expect(classifyText("Broccoli or Cauliflower").category).toBe("produce");
    expect(classifyText("Signature SELECT® Lean Ground Beef").category).toBe("meat");
    expect(classifyText("Boneless Skinless Chicken Breasts").category).toBe("meat");
    expect(classifyText("Frozen Boneless Chicken Breasts").category).toBe("meat");
    expect(classifyText("Oyster Mushrooms").category).toBe("produce");
    expect(classifyText("Beefsteak Tomatoes").category).toBe("produce");
  });

  it("excludes text naming both meat and produce", () => {
    expect(classifyText("Pork Loin with Apples")).toMatchObject({ category: "excluded" });
  });

  it("requires a documented cut for meat, not just a species word", () => {
    expect(classifyText("Swanson Chicken Broth")).toMatchObject({ category: "excluded", reason: expect.stringMatching(/unrecognized/) });
    expect(classifyText("Fresh Pork Loin Filets", "Contains up to 12% solution")).toMatchObject({ category: "excluded", reason: expect.stringMatching(/processed/) });
  });

  it("excludes non-produce groceries that contain a produce word", () => {
    expect(classifyText("Pepper Jack Cheese")).toMatchObject({ category: "excluded", reason: expect.stringMatching(/non-produce/) });
    expect(classifyText("Corn Tortillas")).toMatchObject({ category: "excluded" });
  });

  it("keeps look-alike produce names from borrowing another kind", () => {
    expect(deriveIdentity("produce", "Kiwi Berries")).toMatchObject({ kind: known("kiwi berry"), variety: unknown });
    expect(deriveIdentity("produce", "Rainbow Carrots")).toMatchObject({ kind: known("rainbow carrot") });
    expect(deriveIdentity("produce", "Cauliflower Rice")).toMatchObject({ kind: known("cauliflower"), form: known("riced") });
  });
});

describe("produce identity (R3, R4)", () => {
  it("OR of kinds makes kind unknown", () => {
    const identity = produce("Broccoli or Cauliflower");
    expect(identity).toMatchObject({ category: "produce", kind: unknown });
    expect(comparisonKey(identity)).toBeNull();
  });

  it("OR of varieties keeps the kind but makes variety unknown", () => {
    const identity = produce("Cosmic Crisp, Envy or Pink Lady Apples");
    expect(identity).toMatchObject({ kind: known("apple"), variety: unknown });
    expect(comparisonKey(identity)).toBeNull();
  });

  it("an unrecognized alternative never lets a recognized one stand for the item", () => {
    expect(produce("Honeycrisp or Zestar Apples")).toMatchObject({ kind: known("apple"), variety: unknown });
    expect(produce("Broccoli or Kohlrabi")).toMatchObject({ kind: unknown });
    expect(produce("Kohlrabi or Broccoli")).toMatchObject({ kind: unknown });
  });

  it("variety is required for commercially material kinds", () => {
    expect(produce("Apples")).toMatchObject({ kind: known("apple"), variety: unknown });
    expect(produce("Gala Apples")).toMatchObject({ kind: known("apple"), variety: known("gala") });
    expect(produce("Red Seedless Grapes")).toMatchObject({ kind: known("grape"), variety: known("red seedless") });
    expect(produce("Grape Tomatoes")).toMatchObject({ kind: known("tomato"), variety: known("grape") });
    expect(produce("Orange Bell Peppers")).toMatchObject({ kind: known("pepper"), variety: known("orange bell") });
    expect(produce("Yukon Gold Potatoes")).toMatchObject({ kind: known("potato"), variety: known("yukon gold") });
    expect(produce("Sweet Potatoes")).toMatchObject({ kind: known("sweet potato") });
  });

  it("variety is not-applicable for documented kinds", () => {
    for (const name of ["Strawberries", "Raspberries", "Blackberries", "Blueberries", "Broccoli", "Cauliflower", "Lemons", "Limes"]) {
      expect(produce(name)).toMatchObject({ variety: na });
    }
  });

  it("organic is true only from explicit text and never false from silence", () => {
    expect(produce("Organic Strawberries")).toMatchObject({ organic: known(true) });
    expect(produce("O Organics Bananas")).toMatchObject({ organic: known(true) });
    expect(produce("Simple Truth Organic Gala Apples")).toMatchObject({ organic: known(true) });
    expect(produce("Conventional Bananas")).toMatchObject({ organic: known(false) });
    expect(produce("Non-Organic Bananas")).toMatchObject({ organic: known(false) });
    expect(produce("Strawberries")).toMatchObject({ organic: unknown });
    expect(produce("Organic or Conventional Strawberries")).toMatchObject({ organic: unknown });
  });

  it("form is whole without a qualifier, set by a documented qualifier, unknown on conflict", () => {
    expect(produce("Organic Strawberries")).toMatchObject({ form: known("whole") });
    expect(produce("Sliced Mushrooms")).toMatchObject({ form: known("sliced") });
    expect(produce("Baby Carrots")).toMatchObject({ form: known("baby") });
    expect(produce("Broccoli Florets")).toMatchObject({ form: known("florets") });
    expect(produce("Pineapple Chunks")).toMatchObject({ form: known("cut") });
    expect(produce("Baby Bella Mushrooms")).toMatchObject({ variety: known("cremini"), form: known("whole") });
    expect(produce("Sliced or Whole Mushrooms")).toMatchObject({ form: unknown });
    expect(produce("Diced Sliced Onions")).toMatchObject({ form: unknown });
  });

  it("an assortment marker makes variety unknown", () => {
    expect(produce("Gala Apples, Select Varieties")).toMatchObject({ variety: unknown });
  });

  it("a fully known produce identity yields a key", () => {
    const identity = produce("Organic Strawberries");
    expect(identityGaps(identity)).toEqual([]);
    expect(comparisonKey(identity)).toBe(comparisonKey(produce("Simple Truth Organic Strawberries")));
    expect(comparisonKey(identity)).not.toBeNull();
    expect(comparisonKey(identity)).not.toBe(comparisonKey(produce("Conventional Strawberries")));
  });
});

describe("meat identity (R3, R4)", () => {
  it("bone: boneless out, bone-in in, ground not-applicable, else unknown", () => {
    expect(meat("Boneless Pork Loin Chops")).toMatchObject({ bone: known("out") });
    expect(meat("Bone-In Pork Loin Chops")).toMatchObject({ bone: known("in") });
    expect(meat("Fresh Ground Pork")).toMatchObject({ bone: na });
    expect(meat("Pork Loin Chops")).toMatchObject({ bone: unknown });
  });

  it("skin applies to poultry only", () => {
    expect(meat("Boneless Skinless Chicken Thighs")).toMatchObject({ skin: known("off") });
    expect(meat("Skin-On Chicken Thighs")).toMatchObject({ skin: known("on") });
    expect(meat("Chicken Thighs")).toMatchObject({ skin: unknown });
    expect(meat("Fresh Boneless Beef Chuck Roast")).toMatchObject({ skin: na });
    expect(meat("Fresh Ground Beef 80/20")).toMatchObject({ skin: na });
  });

  it("fresh/frozen only from explicit text", () => {
    expect(meat("Fresh Chicken Drumsticks")).toMatchObject({ freshFrozen: known("fresh") });
    expect(meat("Frozen Chicken Drumsticks")).toMatchObject({ freshFrozen: known("frozen") });
    expect(meat("Chicken Drumsticks", "Previously frozen")).toMatchObject({ freshFrozen: known("frozen") });
    expect(meat("Chicken Drumsticks", "Never frozen")).toMatchObject({ freshFrozen: known("fresh") });
    expect(meat("Chicken Drumsticks")).toMatchObject({ freshFrozen: unknown });
  });

  it("fat applies to ground meat only", () => {
    expect(meat("Fresh 93% Lean Ground Beef")).toMatchObject({ cut: known("ground"), fatPercent: known(7) });
    expect(meat("Fresh Ground Beef 80/20")).toMatchObject({ fatPercent: known(20) });
    expect(meat("Signature SELECT® Lean Ground Beef", "80% Sold in a 3 lb Twin Pack Brick for $14.97 ea")).toMatchObject({ fatPercent: known(20) });
    expect(meat("Fresh Ground Beef")).toMatchObject({ fatPercent: unknown });
    expect(meat("Fresh 80% or 93% Lean Ground Beef")).toMatchObject({ fatPercent: unknown });
    expect(meat("Fresh Boneless Beef Chuck Roast")).toMatchObject({ cut: known("chuck roast"), fatPercent: na });
  });

  it("cross-cut substitution never shares a key", () => {
    const breast = meat("Fresh Boneless Skinless Chicken Breasts");
    const thigh = meat("Fresh Boneless Skinless Chicken Thighs");
    expect(comparisonKey(breast)).not.toBeNull();
    expect(comparisonKey(thigh)).not.toBeNull();
    expect(comparisonKey(breast)).not.toBe(comparisonKey(thigh));

    const lean93 = meat("Fresh 93% Lean Ground Beef");
    const lean80 = meat("Fresh 80% Lean Ground Beef");
    expect(comparisonKey(lean93)).not.toBeNull();
    expect(comparisonKey(lean80)).not.toBeNull();
    expect(comparisonKey(lean93)).not.toBe(comparisonKey(lean80));

    expect(comparisonKey(lean80)).toBe(comparisonKey(meat("Fresh Ground Beef 80/20")));
    const chuck = meat("Fresh Beef Ground Chuck 80/20");
    expect(chuck).toMatchObject({ species: known("beef"), cut: known("ground chuck"), fatPercent: known(20) });
    expect(comparisonKey(chuck)).not.toBeNull();
    expect(comparisonKey(chuck)).not.toBe(comparisonKey(lean80));
    expect(comparisonKey(meat("Fresh Boneless Skinless Turkey Breasts"))).not.toBe(comparisonKey(breast));
  });

  it("OR of cuts makes cut unknown; an unrecognized alternative blocks species", () => {
    // A1: "Boneless" and "Fresh" are stated only in the first alternative, so
    // they do not carry to "Tenders", "Thighs" or "Thin Cut Breasts".
    const chicken = meat("Fresh Draper Valley Boneless Chicken Breasts, Tenders, Thighs or Thin Cut Breasts");
    expect(chicken).toMatchObject({ species: known("chicken"), cut: unknown, bone: unknown, freshFrozen: unknown });
    expect(comparisonKey(chicken)).toBeNull();
    expect(meat("Chicken or Pheasant Breasts")).toMatchObject({ species: unknown });
    expect(classifyText("Chicken or Duck Breasts")).toMatchObject({ category: "excluded", reason: expect.stringMatching(/outside M1 scope/) });
  });

  it("unknown required fields give a null key and are listed", () => {
    const identity = meat("Chicken Breasts");
    expect(comparisonKey(identity)).toBeNull();
    expect(identityGaps(identity)).toEqual(expect.arrayContaining(["bone", "skin", "freshFrozen"]));
  });
});

describe("A1: qualifiers resolve per OR alternative", () => {
  it("a qualifier stated in only one alternative is unknown", () => {
    const berries = produce("Strawberries or Organic Strawberries");
    expect(berries).toMatchObject({ kind: known("strawberry"), organic: unknown });
    expect(comparisonKey(berries)).toBeNull();

    const thighs = meat("Fresh Chicken Thighs or Boneless Skinless Chicken Thighs");
    expect(thighs).toMatchObject({ species: known("chicken"), cut: known("thigh"), bone: unknown, skin: unknown });
    expect(comparisonKey(thighs)).toBeNull();

    expect(produce("Strawberries or Sliced Strawberries")).toMatchObject({ form: unknown });
    expect(meat("Chicken Drumsticks or Fresh Chicken Drumsticks")).toMatchObject({ freshFrozen: unknown });
  });

  it("a qualifier every alternative states the same way stays known", () => {
    expect(produce("Organic Strawberries or Organic Blueberries")).toMatchObject({ kind: unknown, organic: known(true) });
    expect(meat("Fresh Boneless Skinless Chicken Thighs or Fresh Boneless Skinless Chicken Thighs"))
      .toMatchObject({ bone: known("out"), skin: known("off"), freshFrozen: known("fresh") });
  });

  it("description qualifiers apply to every alternative, but description-only organic is unknown", () => {
    expect(meat("Chicken Thighs or Drumsticks", "Fresh Boneless Skinless"))
      .toMatchObject({ bone: known("out"), skin: known("off"), freshFrozen: known("fresh") });
    expect(produce("Strawberries", "Simple Truth Organic")).toMatchObject({ organic: unknown });
    expect(produce("Organic Strawberries", "Simple Truth Organic")).toMatchObject({ organic: known(true) });
    expect(produce("Organic Strawberries", "Conventional")).toMatchObject({ organic: unknown });
  });

  it("negated or exclusionary organic wording is unknown", () => {
    expect(produce("Strawberries", "Excludes Organic")).toMatchObject({ organic: unknown });
    expect(produce("Strawberries, Excluding Organic")).toMatchObject({ organic: unknown });
    expect(produce("Organic Bananas", "Not including organic bunches")).toMatchObject({ organic: unknown });
    expect(produce("Strawberries, Except Organic")).toMatchObject({ organic: unknown });
    expect(produce("Organic Strawberries", "Excludes: organic 2 lb clamshells")).toMatchObject({ organic: unknown });
  });
});

describe("R4 (amended): ground meat skin is not-applicable for every species", () => {
  it("ground poultry gets a key with the lean/fat discriminator", () => {
    const turkey = meat("Fresh 93/7 Ground Turkey");
    expect(turkey).toMatchObject({ species: known("turkey"), cut: known("ground"), bone: na, skin: na, fatPercent: known(7) });
    expect(comparisonKey(turkey)).not.toBeNull();
    const lean = meat("Fresh 93% Lean Ground Turkey");
    expect(comparisonKey(lean)).toBe(comparisonKey(turkey));
    expect(meat("Fresh 93% Lean Ground Chicken")).toMatchObject({ skin: na, fatPercent: known(7) });
  });

  it("identityGaps requires not-applicable skin for ground cuts and a known skin for other poultry", () => {
    const groundTurkey: Identity = {
      category: "meat", species: known("turkey"), cut: known("ground"), bone: na,
      skin: na, freshFrozen: known("fresh"), fatPercent: known(7),
    };
    expect(identityGaps(groundTurkey)).toEqual([]);
    expect(identityGaps({ ...groundTurkey, skin: known("off") })).toContain("skin");
    expect(identityGaps({ ...groundTurkey, skin: unknown })).toContain("skin");
    const thigh: Identity = { ...groundTurkey, cut: known("thigh"), bone: known("out"), fatPercent: na, skin: na };
    expect(identityGaps(thigh)).toContain("skin");
    expect(identityGaps({ ...thigh, skin: known("off") })).toEqual([]);
  });
});

describe("A2: the produce kind must be the head of the name", () => {
  it.each([
    "Simple Truth Organic Ground Ginger",
    "Simple Truth Organic Minced Garlic",
    "Simple Truth Organic Garlic Powder",
    "O Organics Lemon Sparkling Water",
    "Organic Spinach Dip",
    "Organic Tomato Paste",
    "Garlic Bread Seasoning",
  ])("processed or non-head produce %j is excluded", (name) => {
    expect(classifyText(name)).toMatchObject({ category: "excluded", reason: expect.stringMatching(/processed|not the head|non-produce|canned/) });
  });

  it("a processed word in the description excludes produce too", () => {
    expect(classifyText("Garlic", "Minced, 8 oz Jar")).toMatchObject({ category: "excluded", reason: expect.stringMatching(/processed/) });
  });

  it("deriveIdentity never defaults a processed form to whole", () => {
    expect(deriveIdentity("produce", "Organic Garlic Powder")).toMatchObject({ form: unknown });
    expect(comparisonKey(deriveIdentity("produce", "Organic Garlic Powder"))).toBeNull();
  });

  it("real produce names keep working", () => {
    expect(comparisonKey(produce("Organic Strawberries"))).not.toBeNull();
    expect(produce("Gala Apples")).toMatchObject({ kind: known("apple"), variety: known("gala") });
    expect(produce("Envy Apples")).toMatchObject({ kind: known("apple"), variety: known("envy") });
    expect(produce("Broccoli or Cauliflower")).toMatchObject({ kind: unknown });
    expect(produce("Organic Strawberries 1 lb")).toMatchObject({ kind: known("strawberry"), form: known("whole") });
    expect(produce("Russet Potatoes, 5 lb Bag")).toMatchObject({ variety: known("russet") });
    expect(produce("Sweet Corn on the Cob")).toMatchObject({ kind: known("corn") });
    expect(produce("Cantaloupe Melons")).toMatchObject({ kind: known("cantaloupe") });
    expect(produce("Organic Tomatoes on the Vine")).toMatchObject({ variety: known("on the vine") });
    expect(produce("Kiwi Fruit")).toMatchObject({ kind: known("kiwi") });
  });

  it("names that continue past the produce kind are excluded as unrecognized", () => {
    expect(classifyText("Onion Rings")).toMatchObject({ category: "excluded", reason: expect.stringMatching(/not the head/) });
    expect(classifyText("Strawberry Shortcake")).toMatchObject({ category: "excluded" });
  });

  it("Cotton Candy grapes are a grape variety, not candy", () => {
    expect(produce("Cotton Candy Grapes")).toMatchObject({ kind: known("grape"), variety: known("cotton candy") });
    expect(classifyText("Cotton Candy")).toMatchObject({ category: "excluded" });
  });

  it("peeled baby carrots get their own form, distinct from baby carrots", () => {
    const peeled = produce("Signature SELECT Peeled Baby Carrots");
    expect(peeled).toMatchObject({ kind: known("carrot"), form: known("baby-peeled") });
    const organicPeeled = comparisonKey(produce("Organic Peeled Baby Carrots"));
    expect(organicPeeled).not.toBeNull();
    expect(organicPeeled).not.toBe(comparisonKey(produce("Organic Baby Carrots")));
  });
});

describe("A3: meat production claims are excluded", () => {
  it.each([
    "Simple Truth Organic 85% Lean Ground Beef",
    "Open Nature Grass Fed 85% Lean Ground Beef",
    "Grass-Finished Ground Beef",
    "Pasture-Raised Chicken Thighs",
    "Free-Range Whole Chicken",
    "Wagyu Beef Ribeye Steak",
    "Kobe Style Beef Brisket",
    "USDA Prime Beef Ribeye Steak",
  ])("%j is excluded", (name) => {
    expect(classifyText(name)).toMatchObject({ category: "excluded", reason: expect.stringMatching(/production claim not in M1 identity contract/) });
  });

  it("a claim in the description also excludes", () => {
    expect(classifyText("Fresh Chicken Thighs", "USDA Organic")).toMatchObject({ category: "excluded", reason: expect.stringMatching(/production claim/) });
  });

  it("USDA Choice and Certified Angus are a documented known limitation, not excluded", () => {
    expect(classifyText("USDA Choice Beef Ribeye Steak").category).toBe("meat");
    expect(classifyText("Certified Angus Beef Ground Chuck").category).toBe("meat");
  });
});

describe("A4: cut vocabulary keeps different products apart", () => {
  it("a preparation qualifier makes the cut unknown", () => {
    const asada = meat("USDA Choice Beef Boneless Chuck Steak for Carne Asada", "Fresh");
    const plain = meat("USDA Choice Beef Boneless Chuck Steak", "Fresh");
    expect(asada).toMatchObject({ cut: unknown });
    expect(comparisonKey(asada)).toBeNull();
    expect(plain).toMatchObject({ cut: known("chuck steak") });
    expect(comparisonKey(plain)).not.toBeNull();
    expect(comparisonKey(asada)).not.toBe(comparisonKey(plain));
    expect(meat("Fresh Thin Cut Boneless Pork Chops")).toMatchObject({ cut: unknown });
    expect(meat("Fresh St. Louis Style Pork Spareribs")).toMatchObject({ cut: unknown });
    expect(meat("Fresh Beef Top Sirloin Steak", "Thin sliced for stir fry")).toMatchObject({ cut: unknown });
  });

  it("the vocabulary maps thin-cut chicken breasts to a distinct cut", () => {
    expect(meat("Fresh Boneless Skinless Thin Cut Chicken Breasts")).toMatchObject({ cut: unknown });
    expect(meat("Fresh Boneless Skinless Chicken Thin Cut Breasts")).toMatchObject({ cut: known("thin-cut breast") });
  });

  it("roast and steak never share a cut, and a bare ambiguous name is unknown", () => {
    const roast = meat("Fresh Boneless Beef Tri-Tip Roast");
    const steak = meat("Fresh Boneless Beef Tri-Tip Steak");
    expect(roast).toMatchObject({ cut: known("tri-tip roast") });
    expect(steak).toMatchObject({ cut: known("tri-tip steak") });
    expect(comparisonKey(roast)).not.toBeNull();
    expect(comparisonKey(roast)).not.toBe(comparisonKey(steak));
    expect(meat("Fresh Boneless Beef Tri-Tip")).toMatchObject({ cut: unknown });

    expect(meat("Fresh Beef Eye of Round Roast")).toMatchObject({ cut: known("eye of round roast") });
    expect(meat("Fresh Beef Eye of Round Steak")).toMatchObject({ cut: known("eye of round steak") });
    expect(meat("Fresh Beef Eye of Round")).toMatchObject({ cut: unknown });
    expect(meat("Fresh Boneless Beef Ribeye")).toMatchObject({ cut: unknown });
  });

  it("loose vine-ripe tomatoes are not tomatoes on the vine", () => {
    const loose = produce("Organic Vine Ripe Tomatoes");
    const onVine = produce("Organic Tomatoes on the Vine");
    expect(loose).toMatchObject({ variety: known("vine ripe") });
    expect(comparisonKey(loose)).not.toBeNull();
    expect(comparisonKey(loose)).not.toBe(comparisonKey(onVine));
  });
});

describe("text normalization and alternatives (minor fixes)", () => {
  it("strips trademark signs before NFKD so they never glue onto words", () => {
    expect(produce("Envy™ Apples")).toMatchObject({ variety: known("envy") });
    expect(produce("Simple Truth Organic™ Strawberries")).toMatchObject({ organic: known(true) });
    expect(produce("Envy℠ Apples")).toMatchObject({ variety: known("envy") });
  });

  it("a modifier-only alternative must be a variety of the resolved kind", () => {
    expect(produce("Tuscan or Cantaloupe Melons")).toMatchObject({ kind: unknown });
    expect(produce("Red or Green Cabbage")).toMatchObject({ kind: known("cabbage"), variety: unknown });
    expect(produce("Honeycrisp or Gala Apples")).toMatchObject({ kind: known("apple") });
  });
});

describe("comparisonKey enforces documented rules", () => {
  it("rejects known values outside the documented enums", () => {
    const base: Identity = {
      category: "meat", species: known("chicken"), cut: known("thigh"), bone: known("out"),
      skin: known("off"), freshFrozen: known("fresh"), fatPercent: na,
    };
    expect(comparisonKey(base)).not.toBeNull();
    expect(comparisonKey({ ...base, bone: known("sideways") } as unknown as Identity)).toBeNull();
    expect(comparisonKey({ ...base, skin: known("scaled") } as unknown as Identity)).toBeNull();
    expect(comparisonKey({ ...base, freshFrozen: known("thawed") } as unknown as Identity)).toBeNull();
  });

  it("rejects not-applicable where no documented rule allows it", () => {
    const apple: Identity = { category: "produce", kind: known("apple"), variety: na, form: known("whole"), organic: known(true) };
    expect(comparisonKey(apple)).toBeNull();
    const strawberry: Identity = { category: "produce", kind: known("strawberry"), variety: na, form: known("whole"), organic: known(true) };
    expect(comparisonKey(strawberry)).not.toBeNull();
    const steakWithFat: Identity = {
      category: "meat", species: known("beef"), cut: known("ribeye steak"), bone: known("out"),
      skin: na, freshFrozen: known("fresh"), fatPercent: known(20),
    };
    expect(comparisonKey(steakWithFat)).toBeNull();
    const groundWithBone: Identity = {
      category: "meat", species: known("beef"), cut: known("ground"), bone: known("out"),
      skin: na, freshFrozen: known("fresh"), fatPercent: known(20),
    };
    expect(comparisonKey(groundWithBone)).toBeNull();
    const chickenSkinNa: Identity = {
      category: "meat", species: known("chicken"), cut: known("breast"), bone: known("out"),
      skin: na, freshFrozen: known("fresh"), fatPercent: na,
    };
    expect(comparisonKey(chickenSkinNa)).toBeNull();
  });

  it("any unknown required field gives null", () => {
    const base: Identity = { category: "produce", kind: known("strawberry"), variety: na, form: known("whole"), organic: known(true) };
    expect(comparisonKey(base)).not.toBeNull();
    for (const field of ["kind", "variety", "form", "organic"] as const) {
      expect(comparisonKey({ ...base, [field]: unknown })).toBeNull();
    }
  });
});

describe("F1: leftover cut-part and portion words keep different cuts apart", () => {
  it("cross rib roast is its own cut, never a rib roast", () => {
    const rib = meat("Fresh Boneless Beef Rib Roast");
    const cross = meat("Fresh Boneless Beef Cross Rib Roast");
    // "Chuck cross rib roast" is the full standard name of the same cut.
    const chuckCross = meat("USDA Choice Beef Chuck Cross Rib Roast", "Fresh, Boneless");
    expect(rib).toMatchObject({ cut: known("rib roast") });
    expect(cross).toMatchObject({ cut: known("cross rib roast") });
    expect(chuckCross).toMatchObject({ cut: known("cross rib roast") });
    expect(comparisonKey(rib)).not.toBeNull();
    expect(comparisonKey(cross)).not.toBeNull();
    expect(comparisonKey(chuckCross)).not.toBeNull();
    expect(comparisonKey(cross)).not.toBe(comparisonKey(rib));
    expect(comparisonKey(chuckCross)).not.toBe(comparisonKey(rib));
  });

  it.each([
    ["Fresh Boneless Beef Chuck Eye Roast", "Fresh Boneless Beef Sirloin Roast"],
    ["Fresh Boneless Beef Chuck Arm Roast", "Fresh Boneless Beef Round Tip Roast"],
  ])("%j and %j never share a key", (left, right) => {
    for (const name of [left, right]) {
      const identity = meat(name);
      expect(identity).toMatchObject({ species: known("beef"), cut: unknown });
      expect(comparisonKey(identity)).toBeNull();
    }
  });

  it.each([
    ["Fresh Boneless Beef Brisket Point Cut", "Fresh Boneless Beef Brisket"],
    ["Fresh Boneless Beef Brisket Deckle", "Fresh Boneless Beef Brisket"],
    ["Fresh Bone-In Beef Tomahawk Ribeye Steak", "Fresh Bone-In Beef Ribeye Steak"],
    ["Fresh Bone-In Beef Cowboy Ribeye Steak", "Fresh Bone-In Beef Ribeye Steak"],
  ])("B4: %j never shares a key with %j", (qualified, plain) => {
    const left = meat(qualified);
    const right = meat(plain);
    expect(left).toMatchObject({ species: known("beef"), cut: unknown });
    expect(comparisonKey(left)).toBeNull();
    expect(comparisonKey(right)).not.toBeNull();
  });

  it("chicken breast strips never share a key with whole breasts", () => {
    const strips = meat("Fresh Boneless Skinless Chicken Breast Strips");
    const breasts = meat("Fresh Boneless Skinless Chicken Breasts");
    expect(strips).toMatchObject({ species: known("chicken"), cut: unknown });
    expect(comparisonKey(strips)).toBeNull();
    expect(breasts).toMatchObject({ cut: known("breast") });
    expect(comparisonKey(breasts)).not.toBeNull();
  });

  it.each([
    "Fresh Boneless Beef Bottom Round Steak",
    "Fresh Boneless Beef Petite Sirloin Steak",
    "Fresh Boneless Skinless Chicken Breast Fillets",
    "Fresh Boneless Skinless Chicken Breast Bites",
    "Fresh Boneless Pork Belly Slices",
    "Fresh Bone-In Skin-On Chicken Wing Flats",
    "Fresh Whole Chicken Cut Up",
    "Fresh Boneless Beef Brisket Point Cut",
    "Fresh Boneless Beef Brisket Deckle",
    "Fresh Bone-In Beef Tomahawk Ribeye Steak",
    "Fresh Bone-In Beef Cowboy Ribeye Steak",
  ])("a leftover part or portion word makes %j unknown", (name) => {
    const identity = meat(name);
    expect(identity).toMatchObject({ cut: unknown });
    expect(comparisonKey(identity)).toBeNull();
  });

  it.each([
    "Chicken Wing Drummettes",
    "Fresh Bone-In Skin-On Chicken Wing Drummettes",
    "Fresh Bone-In Skin-On Chicken Drummettes",
  ])("B4: %j is a drumette or unknown, never a plain wing", (name) => {
    const identity = meat(name);
    expect(identity).toMatchObject({ species: known("chicken") });
    expect(identity.category === "meat" ? identity.cut : null).not.toEqual(known("wing"));
    expect([known("drumette"), unknown]).toContainEqual(identity.category === "meat" ? identity.cut : null);
    const wing = meat("Fresh Bone-In Skin-On Chicken Wings");
    expect(comparisonKey(identity)).not.toBe(comparisonKey(wing));
  });

  it("B4: drummettes and drumettes spell the same cut", () => {
    expect(meat("Fresh Bone-In Skin-On Chicken Drummettes")).toMatchObject({ cut: known("drumette") });
    expect(meat("Fresh Bone-In Skin-On Chicken Drumettes")).toMatchObject({ cut: known("drumette") });
  });

  it("generic steak, roast, ribs and chops classify as meat but never key", () => {
    for (const name of [
      "Fresh Boneless Beef Steak", "Fresh Boneless Beef Roast", "Fresh Bone-In Pork Ribs",
      "Fresh Boneless Pork Chops", "Fresh Bone-In Pork Chops", "Fresh Bone-In Lamb Chops",
    ]) {
      const identity = meat(name);
      expect(identity).toMatchObject({ cut: unknown });
      expect(comparisonKey(identity)).toBeNull();
    }
  });

  it("a longer vocabulary phrase that consumes these words stays a known, distinct cut", () => {
    const cuts: Array<[string, string]> = [
      ["Fresh Boneless Beef Top Sirloin Steak", "top sirloin steak"],
      ["Fresh Boneless Beef Sirloin Steak", "sirloin steak"],
      ["Fresh Boneless Beef Sirloin Tip Roast", "sirloin tip roast"],
      ["Fresh Boneless Beef Chuck Eye Steak", "chuck eye steak"],
      ["Fresh Boneless Beef Eye of Round Roast", "eye of round roast"],
      ["Fresh Boneless Beef Top Round Steak", "top round steak"],
      ["Fresh Boneless Beef Bottom Round Roast", "bottom round roast"],
      ["Fresh Boneless Pork Loin Chops", "loin chop"],
    ];
    const keys = new Set<string | null>();
    for (const [name, cut] of cuts) {
      const identity = meat(name);
      expect(identity).toMatchObject({ cut: known(cut) });
      expect(comparisonKey(identity)).not.toBeNull();
      keys.add(comparisonKey(identity));
    }
    expect(keys.size).toBe(cuts.length);
    expect(meat("Fresh Beef Ground Round 85/15")).toMatchObject({ cut: known("ground round"), fatPercent: known(15) });
  });
});

describe("F2: celery root and stalk items", () => {
  it("celery root is its own kind, with no variety rule, so it never keys", () => {
    for (const name of ["Organic Celery Root", "Organic Celeriac", "Organic Celery Roots"]) {
      const identity = produce(name);
      expect(identity).toMatchObject({ kind: known("celery root"), variety: unknown });
      expect(comparisonKey(identity)).toBeNull();
    }
    expect(comparisonKey(produce("Organic Celery"))).not.toBeNull();
    expect(produce("Organic Ginger Root")).toMatchObject({ kind: known("ginger") });
  });

  it("Brussels sprouts on the stalk never key as loose Brussels sprouts", () => {
    expect(classifyText("Organic Brussels Sprouts on the Stalk"))
      .toMatchObject({ category: "excluded", reason: expect.stringMatching(/not the head.*stalk/) });
    expect(comparisonKey(produce("Organic Brussels Sprouts"))).not.toBeNull();
  });
});

describe("F3: organic exclusion wording and one segmentation", () => {
  it.each([
    ["Strawberries, Excl. Organic", undefined],
    ["Strawberries, Organic Excluded", undefined],
    ["Organic Strawberries", "Organic not eligible"],
    ["Organic Strawberries", "Organics excepted"],
    ["Organic Strawberries", "Organic not included"],
    ["Organic Strawberries", "Excl organic 2 lb"],
  ])("%j with description %j gives organic unknown and no key", (name, description) => {
    const identity = produce(name, description);
    expect(identity).toMatchObject({ kind: known("strawberry"), organic: unknown });
    expect(comparisonKey(identity)).toBeNull();
  });

  it("a comma segment cannot escape the head-noun rule", () => {
    for (const name of ["Organic Garlic, Butter", "Organic Lemons, Curd"]) {
      expect(classifyText(name)).toMatchObject({ category: "excluded", reason: expect.stringMatching(/not the head/) });
    }
    expect(produce("Russet Potatoes, 5 lb Bag")).toMatchObject({ kind: known("potato"), variety: known("russet") });
    expect(produce("Organic Lettuce, Butter")).toMatchObject({ kind: known("lettuce"), variety: known("butter") });
  });
});

describe("N2: only the resolved kind's variety words may follow it", () => {
  it("another kind's variety word after the kind excludes the item", () => {
    expect(classifyText("Organic Garlic Butter"))
      .toMatchObject({ category: "excluded", reason: expect.stringMatching(/not the head.*butter/) });
    expect(produce("Organic Butter Lettuce")).toMatchObject({ kind: known("lettuce"), variety: known("butter") });
    expect(produce("Organic Tomatoes on the Vine")).toMatchObject({ variety: known("on the vine") });
  });
});

describe("N5: A3 catches organically raised and grown meat", () => {
  it.each([
    "Fresh Organically Raised Chicken Thighs",
    "Organically Grown Boneless Skinless Chicken Breasts",
  ])("%j is excluded", (name) => {
    expect(classifyText(name)).toMatchObject({ category: "excluded", reason: expect.stringMatching(/production claim not in M1 identity contract/) });
  });
});

describe("F4: comparisonKey accepts only documented variety, form and cut values", () => {
  const apple: Identity = { category: "produce", kind: known("apple"), variety: known("gala"), form: known("whole"), organic: known(true) };
  const thigh: Identity = {
    category: "meat", species: known("chicken"), cut: known("thigh"), bone: known("out"),
    skin: known("off"), freshFrozen: known("fresh"), fatPercent: na,
  };

  it("rejects ill-formed strings without throwing", () => {
    expect(comparisonKey(apple)).not.toBeNull();
    expect(comparisonKey(thigh)).not.toBeNull();
    for (const identity of [
      { ...apple, variety: known("\ud800") },
      { ...apple, form: known("\udfff") },
      { ...thigh, cut: known("thigh\ud800") },
    ] as Identity[]) {
      expect(() => comparisonKey(identity)).not.toThrow();
      expect(comparisonKey(identity)).toBeNull();
    }
    expect(identityGaps({ ...apple, variety: known("\ud800") })).toEqual(["variety"]);
  });

  it("rejects values outside the vocabulary, including another kind's variety", () => {
    expect(comparisonKey({ ...apple, variety: known("yukon gold") })).toBeNull();
    expect(comparisonKey({ ...apple, variety: known("gala ") })).toBeNull();
    expect(comparisonKey({ ...apple, form: known("smashed") })).toBeNull();
    expect(comparisonKey({ ...thigh, cut: known("thigh bone") })).toBeNull();
    expect(comparisonKey({ ...thigh, cut: known("?") })).toBeNull();
    expect(identityGaps({ ...thigh, cut: known("steak") })).toContain("cut");
  });

  it("every variety the rules derive, including implied and templated ones, still keys", () => {
    const names: Array<[string, string]> = [
      ["Organic Grape Tomatoes", "grape"],
      ["Organic Red Bell Peppers", "red bell"],
      ["Organic Romaine Lettuce", "romaine"],
      ["Organic Red Seedless Grapes", "red seedless"],
      ["Organic Black Grapes", "black"],
      ["Organic Yellow Onions", "yellow"],
      ["Organic Bi-Color Corn", "bi-color"],
      ["Organic Honey Crisp Apples", "honeycrisp"],
      ["Organic Baby Bella Mushrooms", "cremini"],
    ];
    for (const [name, variety] of names) {
      const identity = produce(name);
      expect(identity).toMatchObject({ variety: known(variety) });
      expect(comparisonKey(identity)).not.toBeNull();
    }
  });
});

describe("fail-closed round: cut words and alternatives in the description (F3, F4)", () => {
  it.each([
    ["Fresh Boneless Beef Brisket", "Point Cut"],
    ["Fresh Boneless Beef Brisket", "Deckle"],
    ["Fresh Bone-In Beef Ribeye Steak", "Tomahawk"],
    ["Fresh Bone-In Skin-On Chicken Wings", "Drummettes"],
  ])("F3: %j with the description %j never shares the plain-cut key", (name, description) => {
    const plain = meat(name);
    expect(comparisonKey(plain)).not.toBeNull();
    const described = meat(name, description);
    expect(described).toMatchObject({ cut: unknown });
    expect(comparisonKey(described)).toBeNull();
  });

  it.each([
    // Live text (QFC item 1039881032, 2026-09-24 run).
    "New York Strip Steaks",
    "Fresh Beef New York Strip Steaks",
  ])("F4: %j with alternatives in the description has cut unknown and never keys", (name) => {
    const identity = meat(name, "or Boneless Chuck Roasts or Steaks");
    expect(identity).toMatchObject({ cut: unknown });
    expect(comparisonKey(identity)).toBeNull();
  });

  it("F4: a description alternative naming another species or kind makes that field unknown", () => {
    const poultry = meat("Fresh Boneless Skinless Chicken Thighs", "or Turkey Thighs");
    expect(poultry).toMatchObject({ species: unknown });
    expect(comparisonKey(poultry)).toBeNull();
    const greens = produce("Organic Broccoli", "or Cauliflower");
    expect(greens).toMatchObject({ kind: unknown });
    expect(comparisonKey(greens)).toBeNull();
    expect(produce("Organic Broccoli", "Cauliflower & Kale")).toMatchObject({ kind: unknown });
    expect(meat("Fresh Boneless Beef New York Strip Steaks", "Steaks/Roasts")).toMatchObject({ cut: unknown });
  });

  it("F4: a description alternative naming another variety of the same kind makes variety unknown", () => {
    const apples = produce("Organic Gala Apples", "or Fuji");
    expect(apples).toMatchObject({ kind: known("apple"), variety: unknown });
    expect(comparisonKey(apples)).toBeNull();
    const same = produce("Organic Gala Apples", "Gala or Gala");
    expect(same).toMatchObject({ variety: known("gala") });
  });

  it("F4: an alternation that names no other vocabulary value leaves the fields known", () => {
    const steak = meat("Fresh Boneless Beef New York Strip Steaks", "Great for grilling or broiling");
    expect(steak).toMatchObject({ species: known("beef"), cut: known("strip steak") });
    expect(comparisonKey(steak)).not.toBeNull();
    const berries = produce("Organic Strawberries", "Sweet and juicy");
    expect(berries).toMatchObject({ kind: known("strawberry") });
    expect(comparisonKey(berries)).not.toBeNull();
  });
});
