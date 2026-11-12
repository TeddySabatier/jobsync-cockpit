// Table-driven stress test of recipientWarning (SPEC §5.3, AC-45), the safety
// net on Send: the bot picks the recipient from UNTRUSTED postings. Synthetic
// data only (acme / evil are placeholders).
vi.mock("@/actions/cockpitSend.actions", () => ({ sendPackage: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));

import { recipientWarning } from "@/components/cockpit/SendDialog";

type Verdict = "ok" | "mismatch" | "free" | "invalid";
const ACME = "Acme";
const P = "https://acme.com/jobs/1";

const cases: [string, string, string | null, string, Verdict][] = [
  // name, company, posting url, recipient, verdict
  // --- legit: the company's own registrable domain -------------------------
  ["exact match", ACME, P, "hr@acme.com", "ok"],
  ["company with Inc, posting host match", "Acme Inc", P, "hr@acme.com", "ok"],
  ["www on the posting host", ACME, "https://www.acme.com/j", "hr@acme.com", "ok"],
  ["mail subdomain of the same domain", ACME, P, "hr@mail.acme.com", "ok"],
  ["careers subdomain on the posting host", ACME, "https://careers.acme.com/x", "jobs@acme.com", "ok"],
  ["careers subdomain on the recipient", ACME, "https://careers.acme.com/x", "hr@careers.acme.com", "ok"],
  ["ATS posting, company key matches", ACME, "https://boards.greenhouse.io/acme/jobs/1", "hr@acme.com", "ok"],
  ["no posting url", ACME, null, "hr@acme.com", "ok"],
  ["co.uk both", ACME, "https://acme.co.uk/j", "hr@acme.co.uk", "ok"],
  ["subdomain of a co.uk domain", ACME, "https://careers.acme.co.uk", "user@sub.acme.co.uk", "ok"],
  ["com.au", ACME, "https://acme.com.au", "hr@acme.com.au", "ok"],
  ["org.uk with subdomain", ACME, "https://acme.org.uk", "hr@mail.acme.org.uk", "ok"],
  ["co.jp", ACME, "https://acme.co.jp", "hr@acme.co.jp", "ok"],
  ["uppercase everywhere", "ACME", "https://ACME.COM/J", "HR@ACME.COM", "ok"],
  ["trailing dot on the recipient host", ACME, P, "hr@acme.com.", "ok"],
  ["trailing dot on the posting host", ACME, "https://acme.com./j", "hr@acme.com", "ok"],
  ["Corp suffix ignored", "Acme Corp", null, "hr@acme.com", "ok"],
  ["whitespace around the address", ACME, P, "  hr@acme.com  ", "ok"],
  ["two-word company, joined", "Acme Labs", null, "hr@acmelabs.com", "ok"],
  ["hyphenated company key", "Acme Labs", null, "hr@acme-labs.com", "ok"],
  ["accented company (Credit Agricole)", "Crédit Agricole", null, "hr@credit-agricole.fr", "ok"],
  ["accented company joined", "Société Générale", null, "hr@societegenerale.com", "ok"],
  ["apostrophe company", "L'Oréal", null, "hr@loreal.com", "ok"],
  // --- evil: attacker controls these --------------------------------------
  ["careers subdomain copied from the posting", ACME, "https://careers.acme.example/1", "hr@careers.evil.example", "mismatch"],
  ["Inc as subdomain", "Acme Inc", null, "hr@inc.evil.example", "mismatch"],
  ["Corp as subdomain", "Acme Corp", null, "hr@corp.evil.example", "mismatch"],
  ["company as subdomain", ACME, null, "hr@acme.evil.com", "mismatch"],
  ["company as sub-subdomain", ACME, null, "hr@careers.acme.evil.example", "mismatch"],
  ["unrelated domain", ACME, P, "hr@evil.com", "mismatch"],
  ["generic subdomain on evil", ACME, P, "hr@jobs.evil.com", "mismatch"],
  ["acme-jobs.com vs acme.com", ACME, P, "hr@acme-jobs.com", "mismatch"],
  ["acmejobs.com", ACME, P, "hr@acmejobs.com", "mismatch"],
  ["acme-careers.com", ACME, P, "hr@acme-careers.com", "mismatch"],
  ["company then com as label: acme.com.evil.com", ACME, P, "hr@acme.com.evil.com", "mismatch"],
  ["acme.co.uk.evil.com", ACME, "https://acme.co.uk", "hr@acme.co.uk.evil.com", "mismatch"],
  ["acme.com.au.evil.com", ACME, "https://acme.com.au", "hr@acme.com.au.evil.com", "mismatch"],
  ["punycode label", ACME, P, "hr@xn--acm-9ua.com", "mismatch"],
  ["unicode look-alike (e acute)", ACME, P, "hr@acmé.com", "mismatch"],
  ["cyrillic a homograph", ACME, P, "hr@аcme.com", "mismatch"],
  ["co.uk: other registrable domain", ACME, "https://acme.co.uk", "hr@evil.co.uk", "mismatch"],
  ["co.uk: company as subdomain of evil", ACME, "https://acme.co.uk", "hr@acme.evil.co.uk", "mismatch"],
  ["com.au: company as subdomain of evil", ACME, "https://acme.com.au", "hr@acme.evil.com.au", "mismatch"],
  ["co.jp: company as subdomain of evil", ACME, "https://acme.co.jp", "hr@acme.evil.co.jp", "mismatch"],
  ["org.uk: company as subdomain of evil", ACME, "https://acme.org.uk", "hr@acme.evil.org.uk", "mismatch"],
  ["gouv.fr style suffix, company as subdomain", ACME, null, "hr@acme.evil.gouv.fr", "mismatch"],
  ["asso.fr style suffix, company as subdomain", ACME, null, "hr@acme.evil.asso.fr", "mismatch"],
  ["ne.jp style suffix, company as subdomain", ACME, null, "hr@acme.evil.ne.jp", "mismatch"],
  ["co.com is a registrable domain", ACME, P, "hr@acme.co.com", "mismatch"],
  ["net.com is a registrable domain", ACME, P, "hr@acme.net.com", "mismatch"],
  ["generic business word of the company", "Acme Technologies", null, "hr@technologies.com", "mismatch"],
  ["generic business word: solutions", "Acme Solutions", null, "hr@solutions.com", "mismatch"],
  ["too short a label", "Ac", null, "hr@ac.com", "mismatch"],
  ["ip address host", ACME, "http://10.0.0.1/j", "hr@10.0.0.1", "mismatch"],
  ["localhost", ACME, P, "hr@localhost", "mismatch"],
  ["recipient with a second @ and evil domain last", ACME, P, "acme.com@evil.com", "mismatch"],
  ["local part is the legit domain", ACME, P, "hr@acme.com@evil.com", "mismatch"],
  // --- free-mail -----------------------------------------------------------
  ["gmail", ACME, P, "acme@gmail.com", "free"],
  ["gmail uppercase", ACME, P, "ACME@GMAIL.COM", "free"],
  ["gmail trailing dot", ACME, P, "acme@gmail.com.", "free"],
  ["gmail subdomain", ACME, P, "hr@mail.gmail.com", "free"],
  ["company named gmail", "Gmail Inc", null, "hr@gmail.com", "free"],
  ["orange.fr", ACME, P, "hr@orange.fr", "free"],
  ["orange.fr subdomain", ACME, P, "hr@sub.orange.fr", "free"],
  ["free.fr", ACME, P, "hr@free.fr", "free"],
  ["laposte.net", ACME, P, "hr@laposte.net", "free"],
  ["hotmail.fr", ACME, P, "hr@hotmail.fr", "free"],
  ["wanadoo.fr", ACME, P, "hr@wanadoo.fr", "free"],
  ["yahoo.fr", ACME, P, "hr@yahoo.fr", "free"],
  ["gmail as a label of another domain", ACME, P, "hr@gmail.com.evil.com", "mismatch"],
  ["notgmail", ACME, P, "hr@notgmail.com", "mismatch"],
  // --- empty / invalid -----------------------------------------------------
  ["empty means apply via link", ACME, P, "", "ok"],
  ["whitespace only", ACME, P, "   ", "ok"],
  ["no @ at all", ACME, P, "not-an-email", "mismatch"],
  ["nothing after the @", ACME, P, "hr@", "invalid"],
  ["only a dot after the @", ACME, P, "hr@.", "invalid"],
];

describe("recipientWarning: table", () => {
  it("has at least 40 cases", () => expect(cases.length).toBeGreaterThanOrEqual(40));
  it.each(cases)("%s", (_name, company, url, to, verdict) => {
    const w = recipientWarning(to, company, url);
    if (verdict === "ok") expect(w).toBeNull();
    else if (verdict === "free") expect(w).toMatch(/free-mail/);
    else if (verdict === "mismatch") expect(w).toMatch(/does not match/);
    else expect(w).toMatch(/./);
  });
});

// Known and accepted limits of a name based check (documented, not a bug):
// the TLD is not compared with the company name, so a TLD swap passes.
describe("recipientWarning: documented limits", () => {
  it("a TLD swap of the company name is not detectable from the name alone", () => {
    expect(recipientWarning("hr@acme.co", ACME, P)).toBeNull();
  });
});
