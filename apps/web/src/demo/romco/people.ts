// The ROMCO demo's people, territories and agents. Every name, address and figure in the demo is
// made up: it is a click-through for a sales conversation, not a client's data, and calls no route.
import type { SopParty } from "@countersign/core";

export const CLIENT = "ROMCO";

/** Agent ids are UUIDs, as the portal's addresses and routes expect. */
export const UCC_ID = "0e5c0c00-0000-4000-8000-000000000001";
export const INVOICE_ID = "0e5c0c00-0000-4000-8000-000000000002";
export const RUN_ID = "R-1042";

export const DANA: SopParty = { key: "dana", kind: "person", name: "Dana Whitfield" };
export const ANA: SopParty = { key: "lead", kind: "mezonas", name: "Ana Torres" };
export const SOL: SopParty = { key: "owner:sales", kind: "agent", name: "Sol" };
export const ME: SopParty = { key: "agent:ucc", kind: "agent", name: "UCC filings review" };
export const TSMS: SopParty = { key: "tsm", kind: "team", name: "Territory sales managers" };
export const RMS: SopParty = { key: "rm", kind: "team", name: "Regional managers" };

export interface Rep {
  key: string;
  name: string;
  email: string;
  territory: string;
  zips: string;
  manager: string;
  managerEmail: string;
  filings: number;
}

export const REPS: Rep[] = [
  {
    key: "marcus",
    name: "Marcus Bell",
    email: "mbell@romco.example",
    territory: "Houston North",
    zips: "773, 77338–77339, 77354–77356",
    manager: "Ray Delgado",
    managerEmail: "rdelgado@romco.example",
    filings: 12,
  },
  {
    key: "kelsey",
    name: "Kelsey Tran",
    email: "ktran@romco.example",
    territory: "Houston South and Coast",
    zips: "770–772, 775–777",
    manager: "Ray Delgado",
    managerEmail: "rdelgado@romco.example",
    filings: 25,
  },
  {
    key: "tyler",
    name: "Tyler Brooks",
    email: "tbrooks@romco.example",
    territory: "Dallas–Fort Worth",
    zips: "750–753, 760–762",
    manager: "Jenna Holt",
    managerEmail: "jholt@romco.example",
    filings: 33,
  },
  {
    key: "andre",
    name: "Andre Wallace",
    email: "awallace@romco.example",
    territory: "East Texas",
    zips: "754–759",
    manager: "Jenna Holt",
    managerEmail: "jholt@romco.example",
    filings: 18,
  },
  {
    key: "luis",
    name: "Luis Ortega",
    email: "lortega@romco.example",
    territory: "San Antonio and South Texas",
    zips: "780–785",
    manager: "Paul Reyes",
    managerEmail: "preyes@romco.example",
    filings: 28,
  },
  {
    key: "hannah",
    name: "Hannah Kim",
    email: "hkim@romco.example",
    territory: "Austin and Central Texas",
    zips: "765–769, 786–789",
    manager: "Paul Reyes",
    managerEmail: "preyes@romco.example",
    filings: 22,
  },
];

export const repByKey = (key: string): Rep => REPS.find((r) => r.key === key) ?? (REPS[0] as Rep);
