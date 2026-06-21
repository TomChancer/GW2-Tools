// salvage-kits.js — Kit definitions and EV calculations
// Exported as a module-like object for use in both frontend and server

const SALVAGE_KITS = {
  copper: {
    id: 'copper',
    name: "Copper-fed Salvage-o-Matic",
    shortName: "Copper-fed",
    costPerUse: 3,          // copper
    ectoRate: 0,            // Basic kit — cannot get ectos from rares
    rareMatsChance: 0.10,
    upgradeRecovery: 'none',   // 20% chance to salvage (destroy) upgrade
    canRecoverUpgrade: false,
    description: "Basic kit. No ectos from rares. Use for whites/blues only.",
  },
  silver: {
    id: 'silver',
    name: "Silver-fed Salvage-o-Matic",
    shortName: "Silver-fed",
    costPerUse: 60,
    ectoRate: 0.875,        // Same as Master's/Mystic — community verified
    exoticEctoRate: 1.258,  // community data: ~1.258 ectos per exotic
    rareMatsChance: 0.25,
    upgradeRecovery: 'none',
    canRecoverUpgrade: false,
    description: "Master's-equivalent. Best for bulk salvaging rares for ectos.",
  },
  masters: {
    id: 'masters',
    name: "Master's Salvage Kit",
    shortName: "Master's Kit",
    costPerUse: 3,          // ~3c per charge (25 charges for 77c at merchant)
    ectoRate: 0.875,
    exoticEctoRate: 1.258,
    rareMatsChance: 0.25,
    upgradeRecovery: 'none',
    canRecoverUpgrade: false,
    description: "Same rates as Silver-fed, but has limited charges.",
  },
  runecrafter: {
    id: 'runecrafter',
    name: "Runecrafter's Salvage-o-Matic",
    shortName: "Runecrafter's",
    costPerUse: 30,
    ectoRate: 0.20,         // 20% rarer mats — lower ecto rate than silver
    exoticEctoRate: 0.20,
    rareMatsChance: 0.20,
    upgradeRecovery: 'salvage', // 100% salvages upgrade into motes/charms/symbols (does NOT recover it)
    canRecoverUpgrade: false,   // Important: does NOT give back the rune/sigil as an item
    description: "Destroys upgrades into Lucent Motes/Charms. Lower ecto rate. Not for ecto farming.",
  },
  blacklion: {
    id: 'blacklion',
    name: "Black Lion Salvage Kit",
    shortName: "Black Lion",
    costPerUse: 500,        // ~500c per charge from TP
    ectoRate: 1.5,          // 50% rarer mats → higher ecto rate (community estimates 1.0–1.5)
    exoticEctoRate: 2.0,
    rareMatsChance: 0.50,
    upgradeRecovery: 'recover', // 100% RECOVERS the actual upgrade component
    canRecoverUpgrade: true,    // The only kit that gives back the rune/sigil
    description: "Only kit that recovers upgrades as items. Worth it when rune/sigil > 500c.",
  },
};

// Calculate salvage EV for a given item + kit combo
// ectoPrice: current ecto buy order price in copper
// upgradePrice: current upgrade buy order price (0 if none/unknown)
function calcSalvageEV(item, kit, ectoPrice, upgradePrice = 0) {
  const TP_FEE = 0.15;
  const rarityNum = { Basic:0, Fine:1, Masterwork:2, Rare:3, Exotic:4, Ascended:5, Legendary:6 }[item.rarity] || 0;
  const isLv68Plus = true; // We assume lv68+ for any rare/exotic in end-game bags

  let ectoEV = 0;
  if (rarityNum >= 3 && isLv68Plus) {
    const rate = rarityNum >= 4 ? (kit.exoticEctoRate || kit.ectoRate) : kit.ectoRate;
    ectoEV = Math.floor(rate * ectoPrice * (1 - TP_FEE));
  }

  let upgradeEV = 0;
  if (upgradePrice > 0) {
    if (kit.canRecoverUpgrade) {
      // Black Lion: get the actual upgrade back, sell it
      upgradeEV = Math.floor(upgradePrice * (1 - TP_FEE));
    }
    // Runecrafter: salvages into motes — value is hard to price, treat as ~0 for now
    // Silver/Master: 80% chance to *destroy* the upgrade for Lucent Motes (~5-10s) 
    // We'll ignore this small value for simplicity
  }

  const totalEV = ectoEV + upgradeEV - kit.costPerUse;
  return { ectoEV, upgradeEV, totalEV, kitCost: kit.costPerUse };
}

if (typeof module !== 'undefined') module.exports = { SALVAGE_KITS, calcSalvageEV };
