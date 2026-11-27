import { useCallback, useEffect, useState } from "react";
import type { ServerPeople as People, ServerPerson } from "../app/server/client";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Badge, Group, Row, SectionHeader } from "./kit";
import { useAppState, useController } from "./store";

/**
 * A server's people, for its admin, under Settings: who is on it, how someone new joins, and a way to sign
 * someone out of every device (a lost phone, a leaked password).
 *
 * How someone joins depends on how the server signs people in. A server that keeps its own accounts lets its admin
 * make a link here, good once, for one person to make theirs. A server that signs people in through a provider
 * (Pocket ID) sends no invites at all: who may come in is decided there, and they are listed here once they have
 * signed in. Shown only to the admin of a server; nothing for anyone else, or for a library of folders.
 */
export function ServerPeople() {
  const c = useController();
  // Asked again when the servers change: connecting to one, or leaving it.
  const servers = useAppState((s) => s.sources.filter((source) => source.server).length);
  const [told, setTold] = useState<(People & { server: string }) | null>(null);
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | "making" | null>(null);
  const [leaving, setLeaving] = useState<ServerPerson | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const ask = useCallback(() => {
    void c
      .serverPeople()
      .then(setTold)
      .catch(() => setTold(null));
  }, [c]);
  useEffect(ask, [ask, servers]);

  if (!told) return null;
  const { people, joining } = told;
  const makeInvite = () => {
    setInvite("making");
    void c
      .inviteToServer()
      .then(setInvite)
      .catch((e: unknown) => {
        setInvite(null);
        setSaid(e instanceof Error ? e.message : "The server couldn't make a link.");
      });
  };
  const signOut = (person: ServerPerson) => {
    setLeaving(null);
    void c
      .signOutEverywhere(person.id)
      .then(() => setSaid(`${person.displayName || person.name} is signed out everywhere, and signs in again on each device.`))
      .catch((e: unknown) => setSaid(e instanceof Error ? e.message : "The server couldn't sign them out."));
  };
  const footer =
    joining?.by === "invite"
      ? "A link lets one person make their account, once, for a few days. Send it to them yourself: Ribbon sends nothing."
      : joining?.by === "provider"
        ? `People sign in to this server through ${joining.name}. Add someone there${joining.address ? ` (${joining.address})` : ""} and they are listed here once they have signed in. Ribbon sends no invites of its own.`
        : undefined;

  return (
    <section aria-labelledby="settings-people" className="flex flex-col gap-4">
      <SectionHeader
        id="settings-people"
        title="People"
        description={`${people.length === 1 ? "One person is" : `${people.length} people are`} on ${told.server}. Each has their own place in every book.`}
        actions={
          joining?.by === "invite" ? (
            <Button size="sm" onClick={makeInvite} disabled={invite === "making"}>
              {invite === "making" ? "Making a link…" : "Invite someone"}
            </Button>
          ) : undefined
        }
      />
      <Group footer={footer}>
        {people.map((person) => (
          <Row
            key={person.id}
            title={person.displayName || person.name}
            description={person.displayName && person.displayName !== person.name ? `Signs in as ${person.name}.` : undefined}
            aside={
              <>
                {person.role === "admin" && <Badge>Admin</Badge>}
                <Button size="sm" variant="ghost" onClick={() => setLeaving(person)}>
                  Sign out everywhere
                </Button>
              </>
            }
          />
        ))}
      </Group>
      {said && (
        <p role="status" className="px-1 text-sm/5 text-ink-2 sm:text-[0.8125rem]/5">
          {said}
        </p>
      )}

      <Dialog
        open={invite !== null && invite !== "making"}
        onClose={() => setInvite(null)}
        labelId="invite-title"
        title="A link for one person"
        description="Whoever opens it chooses a name and a password, and is on the server. It works once."
        actions={
          <>
            <Button variant="ghost" onClick={() => setInvite(null)}>
              Done
            </Button>
            <Button variant="primary" onClick={() => typeof invite === "object" && invite && void navigator.clipboard.writeText(invite.url).then(() => setSaid("The link is copied."))}>
              Copy the link
            </Button>
          </>
        }
      >
        {typeof invite === "object" && invite && (
          <div className="flex flex-col gap-2 px-5 pt-4 pb-5">
            <p className="rounded-md bg-raised px-3 py-2 font-mono text-[0.8125rem]/5 break-all text-ink select-all">{invite.url}</p>
            <p className="text-sm/5 text-ink-3 sm:text-[0.8125rem]/5">Good until {new Date(invite.expiresAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}.</p>
          </div>
        )}
      </Dialog>

      <Dialog
        open={leaving !== null}
        onClose={() => setLeaving(null)}
        labelId="sign-out-title"
        title={`Sign ${leaving?.displayName || leaving?.name || "them"} out everywhere?`}
        description="Every device of theirs asks them to sign in again. Their books, bookmarks and places stay as they are."
        actions={
          <>
            <Button variant="ghost" onClick={() => setLeaving(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => leaving && signOut(leaving)}>
              Sign out everywhere
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </section>
  );
}
