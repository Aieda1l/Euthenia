// Fixed catalog search terms (catalog price amendment, section 5 K1). One
// list serves both chains: K2 sends each term to the Kroger Products API for
// QFC, and S2 sends the same terms to Safeway's store search, so both chains
// are queried for the same products. The terms name common products likely
// stocked at both QFC University Village and Safeway U District, favoring
// kinds and cuts the M1 identity rules can key (a variety where one is
// required, bone and skin for poultry, the lean/fat ratio for ground meat).
// Each term is plain lowercase text of at least 3 characters and at most 8
// words. Changing the list changes what a run can collect, so it is edited
// deliberately, never generated.

/** About 20 produce terms: fruit and vegetables commonly sold loose (PLU) or packaged. */
export const PRODUCE_QUERIES: readonly string[] = [
  // Apples and pears, by variety (variety is required for these kinds).
  "gala apples",
  "honeycrisp apples",
  "fuji apples",
  "granny smith apples",
  "bartlett pears",
  // Fruit whose variety is not applicable in M1.
  "bananas",
  "lemons",
  "limes",
  "strawberries",
  "blueberries",
  // Fruit and vegetables with a required variety or an implied one.
  "red seedless grapes",
  "hass avocados",
  "yellow onions",
  "russet potatoes",
  "red bell peppers",
  "roma tomatoes",
  // Vegetables whose variety is not applicable in M1.
  "carrots",
  "broccoli",
  "cauliflower",
  "zucchini",
];

/** About 15 meat terms: raw beef, pork and poultry cuts plus ground meat (R2). */
export const MEAT_QUERIES: readonly string[] = [
  // Chicken cuts, with bone and skin stated where shoppers choose them.
  "boneless skinless chicken breasts",
  "boneless skinless chicken thighs",
  "bone in chicken thighs",
  "chicken drumsticks",
  "whole chicken",
  // Ground meat, with the lean/fat ratio as the discriminator.
  "ground beef 80/20",
  "ground beef 93/7",
  "ground turkey",
  "ground pork",
  // Pork cuts.
  "boneless pork chops",
  "pork tenderloin",
  "pork shoulder",
  // Beef cuts.
  "beef chuck roast",
  "top sirloin steak",
  "ribeye steak",
];

/** Every catalog search term, produce first. */
export const CATALOG_QUERIES: readonly string[] = [...PRODUCE_QUERIES, ...MEAT_QUERIES];
