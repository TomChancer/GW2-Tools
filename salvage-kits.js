const SALVAGE_KITS = {
  copper: {
    id: 'copper', name: "Copper-fed Salvage-o-Matic", shortName: "Copper-fed",
    costPerUse: 3, ectoRate: 0, exoticEctoRate: 0, rareMatsChance: 0.10,
    canRecoverUpgrade: false,
  },
  silver: {
    id: 'silver', name: "Silver-fed Salvage-o-Matic", shortName: "Silver-fed",
    costPerUse: 60, ectoRate: 0.875, exoticEctoRate: 1.258, rareMatsChance: 0.25,
    canRecoverUpgrade: false,
  },
  masters: {
    id: 'masters', name: "Master's Salvage Kit", shortName: "Master's Kit",
    costPerUse: 3, ectoRate: 0.875, exoticEctoRate: 1.258, rareMatsChance: 0.25,
    canRecoverUpgrade: false,
  },
  runecrafter: {
    id: 'runecrafter', name: "Runecrafter's Salvage-o-Matic", shortName: "Runecrafter's",
    costPerUse: 30, ectoRate: 0.20, exoticEctoRate: 0.20, rareMatsChance: 0.20,
    canRecoverUpgrade: false, // salvages upgrades into motes — does NOT recover them
  },
  blacklion: {
    id: 'blacklion', name: "Black Lion Salvage Kit", shortName: "Black Lion",
    costPerUse: 500, ectoRate: 1.0, exoticEctoRate: 1.5, rareMatsChance: 0.50,
    canRecoverUpgrade: true, // THE only kit that gives back the rune/sigil as an item
  },
};

const RARITY_NUM = { Basic:0, Fine:1, Masterwork:2, Rare:3, Exotic:4, Ascended:5, Legendary:6 };
const TP_FEE = 0.15;

function calcSalvageEV(item, kit, ectoPrice, upgradePrice) {
  upgradePrice = upgradePrice || 0;
  const rarityNum = RARITY_NUM[item.rarity] || 0;
  const canEcto   = rarityNum >= 3;

  let ectoEV = 0;
  if (canEcto && kit.ectoRate > 0) {
    const rate = rarityNum >= 4 ? (kit.exoticEctoRate || kit.ectoRate) : kit.ectoRate;
    ectoEV = Math.floor(rate * ectoPrice * (1 - TP_FEE));
  }

  let upgradeEV = 0;
  if (kit.canRecoverUpgrade && upgradePrice > 0) {
    upgradeEV = Math.floor(upgradePrice * (1 - TP_FEE));
  }

  const totalEV = ectoEV + upgradeEV - kit.costPerUse;
  return { ectoEV, upgradeEV, totalEV, kitCost: kit.costPerUse };
}

module.exports = { SALVAGE_KITS, calcSalvageEV };
