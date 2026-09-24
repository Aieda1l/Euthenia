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
    const chicken = meat("Fresh Draper Valley Boneless Chicken Breasts, Tenders, Thighs or Thin Cut Breasts");
    expect(chicken).toMatchObject({ species: known("chicken"), cut: unknown, bone: known("out"), freshFrozen: known("fresh") });
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

describe("comparisonKey enforces documented rules", () => {
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
