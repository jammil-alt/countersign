// The October UCC file as the demo's run reads it: the raw rows, what verification removed and why,
// and the filings kept, each matched (a deal won or lost, an existing account, or new to ROMCO) and
// assigned to a territory sales manager by ZIP. Made up for the demo.

export type Group = "won" | "lost" | "existing" | "new";

export interface Filing {
  id: string;
  fileNo: string;
  filed: string;
  debtor: string;
  city: string;
  zip: string;
  securedParty: string;
  collateral: string;
  /** What the AI read the collateral as. */
  equipment: string;
  group: Group;
  rep: string;
  deal?: {
    id: string;
    name: string;
    stage: "Closed won" | "Closed lost";
    amount: string;
    lostTo?: string;
  };
  account?: { id: string; since: string; lastPurchase: string };
  /** How sure the match is, 0–100. */
  confidence: number;
  /** Why it matched, in words. */
  why: string;
}

export const FILE = {
  name: "TX_UCC_filings_2026-10.csv",
  size: "1.8 MB",
  rows: 412,
  from: "ucc-data@feed.example",
  to: "ucc@romco.in.mezonas.com",
  arrived: "Mon Nov 3, 8:02 AM",
  period: "October 2026",
};

/** The first rows of the file, as it came. */
export const RAW = `FILE_NO,FILE_DATE,FILING_TYPE,DEBTOR_NAME,DEBTOR_ADDR,DEBTOR_CITY,ST,ZIP,SECURED_PARTY,COLLATERAL
2026-0193344,10/01/2026,UCC1,MONTGOMERY COUNTY SITE WORKS LLC,1410 N FRAZIER ST,CONROE,TX,77301,FROST BANK,"TWO (2) 2026 HYDRAULIC EXCAVATORS 30 TON CLASS S/N EX30-11842 EX30-11857 TOGETHER WITH ALL ATTACHMENTS"
2026-0193351,10/01/2026,UCC3 TERM,GULF FREIGHTWAYS INC,800 PORT RD,PASADENA,TX,77506,FIRST CITIZENS BANK,TERMINATION OF 2021-0044172
2026-0193390,10/01/2026,UCC1,SPRING CREEK PAVING CO,22110 KUYKENDAHL RD,SPRING,TX,77373,CATERPILLAR FINANCIAL SERVICES CORP,"2026 ASPHALT PAVER AP555F S/N CAT0AP55KXL00418"
2026-0193402,10/01/2026,UCC1,BAYOU CITY DENTAL PARTNERS PLLC,2600 SW FWY STE 400,HOUSTON,TX,77098,LIVE OAK BANK,"ALL DENTAL EQUIPMENT FURNITURE AND FIXTURES NOW OWNED OR HEREAFTER ACQUIRED"
2026-0193417,10/02/2026,UCC1,LAKE CREEK UTILITIES INC,15025 FM 1097 W,MONTGOMERY,TX,77356,DLL FINANCE LLC,"2026 WHEEL LOADER 3.5 YD BUCKET S/N WL35-60231"
2026-0193425,10/02/2026,UCC3 CONT,HARRIS CO LANDSCAPING LLC,9902 ALDINE BENDER,HOUSTON,TX,77093,AMERICAN NATIONAL BANK,CONTINUATION OF 2021-0051908
2026-0193461,10/02/2026,UCC1,LONE STAR LOGISTICS LLC,4400 IRVINGTON BLVD,HOUSTON,TX,77009,PACCAR FINANCIAL CORP,"(4) 2026 FREIGHTLINER CASCADIA TRACTORS VINS 3AKJHHDR1TSKA2210 THRU 2213"
2026-0193477,10/03/2026,UCC1,HUMBLE DIRT & HAUL LLC,2311 FM 1960 E,HUMBLE,TX,77338,KOMATSU FINANCIAL LP,"2025 ARTICULATED DUMP TRUCK HM400-5 S/N 21418"
2026-0193480,10/03/2026,UCC1,TOMBALL GRADING & EXCAVATION,27310 HUFSMITH KOHRVILLE,TOMBALL,TX,77375,JOHN DEERE FINANCIAL,"2026 CRAWLER DOZER 850 P-TIER S/N 1T0850PXKPF441902"
2026-0193484,10/03/2026,UCC1,RIO GRANDE PECAN FARMS,RR 2 BOX 118,MISSION,TX,78572,JOHN DEERE FINANCIAL,"2025 6R 145 AGRICULTURAL TRACTOR WITH LOADER"
2026-0193499,10/03/2026,UCC1,PERMIAN BASIN FABRICATION INC,3100 W I-20,ODESSA,TX,79763,TEXAS CAPITAL BANK,"ALL ASSETS OF DEBTOR NOW OWNED OR HEREAFTER ACQUIRED"
2026-0193512,10/06/2026,UCC1,WOODLANDS COMMERCIAL BUILDERS,9595 SIX PINES DR,THE WOODLANDS,TX,77380,KUBOTA CREDIT CORP USA,"(3) 2026 COMPACT TRACK LOADERS SVL97-2"
2026-0193515,10/06/2026,UCC1,SHREVEPORT SITE PREP LLC,500 CLYDE FANT PKWY,SHREVEPORT,LA,71101,REGIONS EQUIPMENT FINANCE,"2026 MOTOR GRADER 14FT MOLDBOARD"
2026-0193520,10/06/2026,UCC1,MAGNOLIA RIDGE DEVELOPMENT LLC,32710 FM 2978,MAGNOLIA,TX,77354,TEXAS CAPITAL BANK,"2026 MOTOR GRADER 14 FT MOLDBOARD S/N MG14-00882"
2026-0193523,10/06/2026,UCC1,MONTGOMERY COUNTY SITE WORKS LLC,1410 N FRAZIER ST,CONROE,TX,77301,FROST BANK,"TWO (2) 2026 HYDRAULIC EXCAVATORS 30 TON CLASS S/N EX30-11842 EX30-11857"
2026-0193541,10/07/2026,UCC3 AMND,TRINITY PAVING CO,2200 IRVING BLVD,DALLAS,TX,75207,WELLS FARGO EQUIPMENT FINANCE,DEBTOR ADDRESS CHANGE
2026-0193560,10/07/2026,UCC1,ACME OFFICE SOLUTIONS LP,1200 SMITH ST,HOUSTON,TX,77002,DLL FINANCE LLC,"ALL COPIERS AND PRINTERS LEASED UNDER MASTER LEASE 55-1180"
2026-0193577,10/07/2026,UCC1,CLEVELAND PIPE & BORE LLC,1880 S WASHINGTON AVE,CLEVELAND,TX,77327,AMUR EQUIPMENT FINANCE,"2025 HORIZONTAL DIRECTIONAL DRILL 36000 LB CLASS"
…  394 more rows`;

/** Three records as step 2 wrote them. */
export const JSON_SAMPLE = `[
  {
    "fileNo": "2026-0193344",
    "filed": "2026-10-01",
    "type": "UCC-1",
    "debtor": {
      "name": "Montgomery County Site Works LLC",
      "address": "1410 N Frazier St",
      "city": "Conroe", "state": "TX", "zip": "77301"
    },
    "securedParty": "Frost Bank",
    "collateral": {
      "text": "TWO (2) 2026 HYDRAULIC EXCAVATORS 30 TON CLASS S/N EX30-11842 EX30-11857 …",
      "items": [
        { "kind": "excavator", "class": "30 ton", "year": 2026, "serial": "EX30-11842" },
        { "kind": "excavator", "class": "30 ton", "year": 2026, "serial": "EX30-11857" }
      ],
      "category": "construction"
    },
    "source": { "file": "TX_UCC_filings_2026-10.csv", "row": 2 }
  },
  {
    "fileNo": "2026-0193351",
    "filed": "2026-10-01",
    "type": "UCC-3 termination",
    "debtor": { "name": "Gulf Freightways Inc", "city": "Pasadena", "state": "TX", "zip": "77506" },
    "securedParty": "First Citizens Bank",
    "collateral": { "text": "TERMINATION OF 2021-0044172", "items": [], "category": null },
    "source": { "file": "TX_UCC_filings_2026-10.csv", "row": 3 }
  },
  {
    "fileNo": "2026-0193390",
    "filed": "2026-10-01",
    "type": "UCC-1",
    "debtor": {
      "name": "Spring Creek Paving Co",
      "address": "22110 Kuykendahl Rd",
      "city": "Spring", "state": "TX", "zip": "77373"
    },
    "securedParty": "Caterpillar Financial Services Corp",
    "collateral": {
      "text": "2026 ASPHALT PAVER AP555F S/N CAT0AP55KXL00418",
      "items": [{ "kind": "asphalt paver", "year": 2026, "serial": "CAT0AP55KXL00418" }],
      "category": "paving"
    },
    "source": { "file": "TX_UCC_filings_2026-10.csv", "row": 4 }
  }
]`;

export interface RemovedReason {
  key: string;
  reason: string;
  how: "Rules" | "AI";
  count: number;
}

export const REMOVED: RemovedReason[] = [
  {
    key: "term",
    reason: "Terminations (a loan paid off, nothing bought)",
    how: "Rules",
    count: 61,
  },
  { key: "cont", reason: "Continuations of older filings", how: "Rules", count: 48 },
  { key: "amnd", reason: "Amendments that add no equipment", how: "Rules", count: 37 },
  { key: "dup", reason: "Duplicates of a filing already in the file", how: "Rules", count: 15 },
  { key: "out", reason: "Debtor outside ROMCO's territories", how: "Rules", count: 31 },
  {
    key: "notours",
    reason: "Not equipment ROMCO sells (trucks, farm tractors, office, blanket liens)",
    how: "AI",
    count: 82,
  },
];

export const REMOVED_SAMPLE: {
  fileNo: string;
  debtor: string;
  what: string;
  why: string;
  how: "Rules" | "AI";
}[] = [
  {
    fileNo: "2026-0193351",
    debtor: "Gulf Freightways Inc",
    what: "UCC-3 termination",
    why: "Termination",
    how: "Rules",
  },
  {
    fileNo: "2026-0193425",
    debtor: "Harris Co Landscaping LLC",
    what: "UCC-3 continuation",
    why: "Continuation",
    how: "Rules",
  },
  {
    fileNo: "2026-0193541",
    debtor: "Trinity Paving Co",
    what: "Address change",
    why: "Amendment, no new equipment",
    how: "Rules",
  },
  {
    fileNo: "2026-0193523",
    debtor: "Montgomery County Site Works LLC",
    what: "2 excavators",
    why: "Duplicate of 2026-0193344",
    how: "Rules",
  },
  {
    fileNo: "2026-0193515",
    debtor: "Shreveport Site Prep LLC",
    what: "Motor grader",
    why: "Louisiana, outside the territories",
    how: "Rules",
  },
  {
    fileNo: "2026-0193402",
    debtor: "Bayou City Dental Partners PLLC",
    what: "Dental equipment",
    why: "Not equipment ROMCO sells",
    how: "AI",
  },
  {
    fileNo: "2026-0193461",
    debtor: "Lone Star Logistics LLC",
    what: "4 highway tractors",
    why: "On-road trucks",
    how: "AI",
  },
  {
    fileNo: "2026-0193484",
    debtor: "Rio Grande Pecan Farms",
    what: "Farm tractor",
    why: "Agricultural",
    how: "AI",
  },
  {
    fileNo: "2026-0193499",
    debtor: "Permian Basin Fabrication Inc",
    what: "All assets",
    why: "Blanket lien, no equipment named",
    how: "AI",
  },
  {
    fileNo: "2026-0193560",
    debtor: "Acme Office Solutions LP",
    what: "Copiers",
    why: "Office equipment",
    how: "AI",
  },
];

const f = (x: Filing): Filing => x;

export const FILINGS: Filing[] = [
  // Marcus Bell, Houston North: 2 won, 2 lost, 5 existing, 3 new.
  f({
    id: "f1",
    fileNo: "2026-0193344",
    filed: "Oct 1",
    debtor: "Montgomery County Site Works LLC",
    city: "Conroe",
    zip: "77301",
    securedParty: "Frost Bank",
    collateral: "Two 2026 hydraulic excavators, 30-ton class",
    equipment: "Excavators (2)",
    group: "won",
    rep: "marcus",
    confidence: 99,
    deal: {
      id: "D-2291",
      name: "MCSW – two 30-ton excavators",
      stage: "Closed won",
      amount: "$612,000",
    },
    why: "Same customer, two 30-ton excavators, deal closed Sep 22",
  }),
  f({
    id: "f2",
    fileNo: "2026-0193417",
    filed: "Oct 2",
    debtor: "Lake Creek Utilities Inc",
    city: "Montgomery",
    zip: "77356",
    securedParty: "DLL Finance LLC",
    collateral: "2026 wheel loader, 3.5 yd bucket",
    equipment: "Wheel loader",
    group: "won",
    rep: "marcus",
    confidence: 97,
    deal: {
      id: "D-2307",
      name: "Lake Creek – wheel loader",
      stage: "Closed won",
      amount: "$248,500",
    },
    why: "Same customer and model, deal closed Sep 30",
  }),
  f({
    id: "f3",
    fileNo: "2026-0193390",
    filed: "Oct 1",
    debtor: "Spring Creek Paving Co",
    city: "Spring",
    zip: "77373",
    securedParty: "Caterpillar Financial Services Corp",
    collateral: "2026 asphalt paver",
    equipment: "Asphalt paver",
    group: "lost",
    rep: "marcus",
    confidence: 96,
    deal: {
      id: "D-2264",
      name: "Spring Creek – asphalt paver",
      stage: "Closed lost",
      amount: "$389,000",
      lostTo: "Price",
    },
    why: "Same customer, paver quoted Aug 14, deal closed lost Sep 8",
  }),
  f({
    id: "f4",
    fileNo: "2026-0193477",
    filed: "Oct 3",
    debtor: "Humble Dirt & Haul LLC",
    city: "Humble",
    zip: "77338",
    securedParty: "Komatsu Financial LP",
    collateral: "2025 articulated dump truck",
    equipment: "Articulated truck",
    group: "lost",
    rep: "marcus",
    confidence: 94,
    deal: {
      id: "D-2279",
      name: "HDH – articulated truck",
      stage: "Closed lost",
      amount: "$455,000",
      lostTo: "Availability",
    },
    why: "Same customer, 40-ton truck quoted Aug 28, closed lost Sep 19",
  }),
  f({
    id: "f5",
    fileNo: "2026-0193480",
    filed: "Oct 3",
    debtor: "Tomball Grading & Excavation",
    city: "Tomball",
    zip: "77375",
    securedParty: "John Deere Financial",
    collateral: "2026 crawler dozer",
    equipment: "Crawler dozer",
    group: "existing",
    rep: "marcus",
    confidence: 98,
    account: { id: "A-10422", since: "2014", lastPurchase: "Mar 2025" },
    why: "Account A-10422 by name and address; no open or recent deal",
  }),
  f({
    id: "f6",
    fileNo: "2026-0193512",
    filed: "Oct 6",
    debtor: "Woodlands Commercial Builders",
    city: "The Woodlands",
    zip: "77380",
    securedParty: "Kubota Credit Corp USA",
    collateral: "Three 2026 compact track loaders",
    equipment: "Compact track loaders (3)",
    group: "existing",
    rep: "marcus",
    confidence: 95,
    account: { id: "A-09811", since: "2011", lastPurchase: "Jun 2024" },
    why: "Account A-09811 by name; address matches the billing address",
  }),
  f({
    id: "f7",
    fileNo: "2026-0193577",
    filed: "Oct 7",
    debtor: "Cleveland Pipe & Bore LLC",
    city: "Cleveland",
    zip: "77327",
    securedParty: "Amur Equipment Finance",
    collateral: "2025 horizontal directional drill",
    equipment: "Directional drill",
    group: "existing",
    rep: "marcus",
    confidence: 91,
    account: { id: "A-12290", since: "2019", lastPurchase: "Nov 2023" },
    why: "Account A-12290 by name; ZIP matches",
  }),
  f({
    id: "f8",
    fileNo: "2026-0193602",
    filed: "Oct 9",
    debtor: "Huntsville Timber & Land Clearing",
    city: "Huntsville",
    zip: "77340",
    securedParty: "Wells Fargo Equipment Finance",
    collateral: "2025 tracked forestry mulcher",
    equipment: "Forestry mulcher",
    group: "existing",
    rep: "marcus",
    confidence: 88,
    account: { id: "A-11873", since: "2017", lastPurchase: "Feb 2023" },
    why: 'Account A-11873 by name ("Huntsville Timber"); address differs, marked to confirm',
  }),
  f({
    id: "f9",
    fileNo: "2026-0193655",
    filed: "Oct 14",
    debtor: "North Harris Septic & Site",
    city: "Spring",
    zip: "77388",
    securedParty: "Ally Bank",
    collateral: "2026 mini excavator, 8-ton class",
    equipment: "Mini excavator",
    group: "existing",
    rep: "marcus",
    confidence: 96,
    account: { id: "A-10967", since: "2016", lastPurchase: "Aug 2025" },
    why: "Account A-10967 by name and address",
  }),
  f({
    id: "f10",
    fileNo: "2026-0193520",
    filed: "Oct 6",
    debtor: "Magnolia Ridge Development LLC",
    city: "Magnolia",
    zip: "77354",
    securedParty: "Texas Capital Bank",
    collateral: "2026 motor grader, 14 ft moldboard",
    equipment: "Motor grader",
    group: "new",
    rep: "marcus",
    confidence: 100,
    why: "No deal, account or contact by name, address or phone",
  }),
  f({
    id: "f11",
    fileNo: "2026-0193688",
    filed: "Oct 16",
    debtor: "Willis Ready Mix Hauling",
    city: "Willis",
    zip: "77378",
    securedParty: "PNC Equipment Finance",
    collateral: "Two 2026 skid steer loaders and attachments",
    equipment: "Skid steers (2)",
    group: "new",
    rep: "marcus",
    confidence: 100,
    why: "No deal, account or contact by name, address or phone",
  }),
  f({
    id: "f12",
    fileNo: "2026-0193731",
    filed: "Oct 21",
    debtor: "Kingwood Trenching Services",
    city: "Kingwood",
    zip: "77339",
    securedParty: "Balboa Capital Corp",
    collateral: "2025 ride-on trencher",
    equipment: "Trencher",
    group: "new",
    rep: "marcus",
    confidence: 100,
    why: "No deal, account or contact by name, address or phone",
  }),
  // The other territories, a sample.
  f({
    id: "f13",
    fileNo: "2026-0193538",
    filed: "Oct 7",
    debtor: "Golden Triangle Demolition",
    city: "Beaumont",
    zip: "77701",
    securedParty: "Regions Equipment Finance",
    collateral: "2026 demolition excavator, high reach",
    equipment: "Demolition excavator",
    group: "won",
    rep: "kelsey",
    confidence: 98,
    deal: {
      id: "D-2302",
      name: "GTD – high-reach excavator",
      stage: "Closed won",
      amount: "$735,000",
    },
    why: "Same customer and machine, deal closed Sep 26",
  }),
  f({
    id: "f14",
    fileNo: "2026-0193547",
    filed: "Oct 7",
    debtor: "Pearland Site Utilities",
    city: "Pearland",
    zip: "77581",
    securedParty: "Caterpillar Financial Services Corp",
    collateral: "2026 backhoe loader",
    equipment: "Backhoe loader",
    group: "lost",
    rep: "kelsey",
    confidence: 93,
    deal: {
      id: "D-2270",
      name: "PSU – backhoes",
      stage: "Closed lost",
      amount: "$162,000",
      lostTo: "Financing",
    },
    why: "Same customer, backhoe quoted Aug 20, closed lost Sep 15",
  }),
  f({
    id: "f15",
    fileNo: "2026-0193611",
    filed: "Oct 9",
    debtor: "Bay Area Marine Construction",
    city: "Baytown",
    zip: "77520",
    securedParty: "Frost Bank",
    collateral: "2026 crawler crane, 110-ton",
    equipment: "Crawler crane",
    group: "existing",
    rep: "kelsey",
    confidence: 97,
    account: { id: "A-08854", since: "2009", lastPurchase: "Jan 2025" },
    why: "Account A-08854 by name and address",
  }),
  f({
    id: "f16",
    fileNo: "2026-0193640",
    filed: "Oct 13",
    debtor: "Gulf Coast Ditching LLC",
    city: "Freeport",
    zip: "77541",
    securedParty: "Amur Equipment Finance",
    collateral: "2025 long-reach excavator",
    equipment: "Long-reach excavator",
    group: "new",
    rep: "kelsey",
    confidence: 100,
    why: "No deal, account or contact",
  }),
  f({
    id: "f17",
    fileNo: "2026-0193377",
    filed: "Oct 1",
    debtor: "Trinity Paving Co",
    city: "Dallas",
    zip: "75212",
    securedParty: "Wells Fargo Equipment Finance",
    collateral: "2026 tandem vibratory roller",
    equipment: "Roller",
    group: "won",
    rep: "tyler",
    confidence: 99,
    deal: {
      id: "D-2288",
      name: "Trinity – tandem roller",
      stage: "Closed won",
      amount: "$176,400",
    },
    why: "Same customer and model, deal closed Sep 24",
  }),
  f({
    id: "f18",
    fileNo: "2026-0193466",
    filed: "Oct 3",
    debtor: "Grand Prairie Utility Group",
    city: "Grand Prairie",
    zip: "75050",
    securedParty: "John Deere Financial",
    collateral: "2026 wheel loader",
    equipment: "Wheel loader",
    group: "lost",
    rep: "tyler",
    confidence: 95,
    deal: {
      id: "D-2259",
      name: "GPUG – loader replacement",
      stage: "Closed lost",
      amount: "$298,000",
      lostTo: "Relationship",
    },
    why: "Same customer, loader quoted Aug 6, closed lost Sep 2",
  }),
  f({
    id: "f19",
    fileNo: "2026-0193590",
    filed: "Oct 8",
    debtor: "Denton Dirtworks",
    city: "Denton",
    zip: "76205",
    securedParty: "Kubota Credit Corp USA",
    collateral: "Two 2026 compact excavators",
    equipment: "Compact excavators (2)",
    group: "existing",
    rep: "tyler",
    confidence: 94,
    account: { id: "A-11320", since: "2018", lastPurchase: "Apr 2025" },
    why: "Account A-11320 by name; phone matches",
  }),
  f({
    id: "f20",
    fileNo: "2026-0193702",
    filed: "Oct 17",
    debtor: "Mansfield Haul & Grade",
    city: "Mansfield",
    zip: "76063",
    securedParty: "DLL Finance LLC",
    collateral: "2026 motor grader",
    equipment: "Motor grader",
    group: "new",
    rep: "tyler",
    confidence: 100,
    why: "No deal, account or contact",
  }),
  f({
    id: "f21",
    fileNo: "2026-0193492",
    filed: "Oct 3",
    debtor: "Red River Grading",
    city: "Texarkana",
    zip: "75501",
    securedParty: "Texas Capital Bank",
    collateral: "2026 crawler dozer",
    equipment: "Crawler dozer",
    group: "won",
    rep: "andre",
    confidence: 98,
    deal: { id: "D-2296", name: "Red River – dozer", stage: "Closed won", amount: "$341,000" },
    why: "Same customer and model, deal closed Sep 25",
  }),
  f({
    id: "f22",
    fileNo: "2026-0193620",
    filed: "Oct 10",
    debtor: "Piney Woods Clearing",
    city: "Tyler",
    zip: "75703",
    securedParty: "Wells Fargo Equipment Finance",
    collateral: "2026 tracked mulcher",
    equipment: "Forestry mulcher",
    group: "new",
    rep: "andre",
    confidence: 100,
    why: "No deal, account or contact",
  }),
  f({
    id: "f23",
    fileNo: "2026-0193571",
    filed: "Oct 7",
    debtor: "Alamo Earthmovers",
    city: "San Antonio",
    zip: "78219",
    securedParty: "Komatsu Financial LP",
    collateral: "2026 hydraulic excavator, 36-ton",
    equipment: "Excavator",
    group: "existing",
    rep: "luis",
    confidence: 97,
    account: { id: "A-07760", since: "2006", lastPurchase: "Oct 2024" },
    why: "Account A-07760 by name and address",
  }),
  f({
    id: "f24",
    fileNo: "2026-0193666",
    filed: "Oct 15",
    debtor: "Nueces Pipeline Services",
    city: "Corpus Christi",
    zip: "78405",
    securedParty: "CNH Industrial Capital",
    collateral: "2026 pipelayer",
    equipment: "Pipelayer",
    group: "new",
    rep: "luis",
    confidence: 100,
    why: "No deal, account or contact",
  }),
  f({
    id: "f25",
    fileNo: "2026-0193533",
    filed: "Oct 6",
    debtor: "Hill Country Excavation",
    city: "Dripping Springs",
    zip: "78620",
    securedParty: "Caterpillar Financial Services Corp",
    collateral: "2026 hydraulic excavator, 25-ton",
    equipment: "Excavator",
    group: "lost",
    rep: "hannah",
    confidence: 92,
    deal: {
      id: "D-2275",
      name: "HCE – 25-ton excavator",
      stage: "Closed lost",
      amount: "$318,000",
      lostTo: "Price",
    },
    why: "Same customer, excavator quoted Aug 25, closed lost Sep 17",
  }),
  f({
    id: "f26",
    fileNo: "2026-0193629",
    filed: "Oct 10",
    debtor: "Brazos Valley Earthworks",
    city: "Waco",
    zip: "76705",
    securedParty: "John Deere Financial",
    collateral: "2026 articulated dump truck",
    equipment: "Articulated truck",
    group: "existing",
    rep: "hannah",
    confidence: 90,
    account: { id: "A-10088", since: "2015", lastPurchase: "Dec 2024" },
    why: "Account A-10088 by name; address differs, marked to confirm",
  }),
];

export const GROUP_WORDS: Record<Group, string> = {
  won: "On a deal: won",
  lost: "On a deal: lost",
  existing: "Existing client, no deal",
  new: "New to ROMCO",
};

/** The run's totals (the samples above are part of them). */
export const TOTALS = {
  read: 412,
  removed: 274,
  kept: 138,
  won: 17,
  lost: 24,
  existing: 52,
  new: 45,
  unsure: 4,
};

/** Won, lost, existing and new, by sales manager. */
export const BY_REP: Record<string, [number, number, number, number]> = {
  marcus: [2, 2, 5, 3],
  kelsey: [3, 5, 10, 7],
  tyler: [5, 6, 12, 10],
  andre: [2, 3, 6, 7],
  luis: [3, 5, 11, 9],
  hannah: [2, 3, 8, 9],
};

/** Why ROMCO missed or lost a sale: the analysis of the six forms (step 9). */
export const THEMES: { theme: string; n: number; share: number; words: string; quote: string }[] = [
  {
    theme: "We didn't know they were buying",
    n: 38,
    share: 31,
    words: "Existing clients and new buyers the sales manager hadn't heard from",
    quote: '"Haven\'t had a call with Tomball Grading since spring." Marcus Bell',
  },
  {
    theme: "Price or financing",
    n: 18,
    share: 15,
    words: "Quoted, or would have been, and lost on price, rate or terms",
    quote: '"Their bank beat our financing by a point." Luis Ortega',
  },
  {
    theme: "National or fleet account",
    n: 14,
    share: 12,
    words: "Bought through a national account ROMCO doesn't hold",
    quote: '"Corporate buys these through a fleet deal." Tyler Brooks',
  },
  {
    theme: "Brand or line ROMCO doesn't carry",
    n: 12,
    share: 10,
    words: "Equipment or size ROMCO couldn't offer",
    quote: '"We don\'t carry a 110-ton crawler crane." Kelsey Tran',
  },
  {
    theme: "Availability",
    n: 9,
    share: 7,
    words: "Needed it sooner than ROMCO could deliver",
    quote: '"They needed it in two weeks; ours was eight." Marcus Bell',
  },
];
