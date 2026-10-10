/**
 * The email carries the link and the expiry date, nothing else. The summary itself only ever lives
 * behind the link, so an inbox never holds PHI.
 */
export interface LinkEmail {
  to: string;
  subject: string;
  text: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export function patientLinkEmail(input: { to: string; link: string; expiresAt: string }): LinkEmail {
  return {
    to: input.to,
    subject: "Your discharge summary is ready",
    text: [
      "Your discharge summary is ready.",
      "",
      `Open it here: ${input.link}`,
      "",
      `This link works until ${formatDate(input.expiresAt)}. After that date the information is permanently deleted and cannot be recovered.`,
      "",
      "If you did not expect this message, you can ignore it. Do not forward the link; it is yours alone.",
    ].join("\n"),
  };
}

export function caregiverLinkEmail(input: { to: string; link: string; expiresAt: string }): LinkEmail {
  return {
    to: input.to,
    subject: "A discharge summary was shared with you",
    text: [
      "A patient has approved sharing their discharge summary with you.",
      "",
      `Open it here: ${input.link}`,
      "",
      `This link works until ${formatDate(input.expiresAt)}. After that date the information is permanently deleted.`,
      "",
      "Please keep this link private.",
    ].join("\n"),
  };
}
