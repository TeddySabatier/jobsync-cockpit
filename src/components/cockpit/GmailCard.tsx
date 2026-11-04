"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { disconnectGmail } from "@/actions/cockpitGmail.actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toastError, toastSuccess } from "@/lib/toast";

// Props are display data only: the account arrives with an explicit select of
// email and scopes, never the token or iv (SPEC §5.5, AC-43).
export default function GmailCard({
  account,
  missingEnv,
  errorMessage,
  justConnected,
}: {
  account: { email: string; scopes: string } | null;
  missingEnv: string[];
  errorMessage: string | null;
  justConnected: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const configured = missingEnv.length === 0;

  const disconnect = () =>
    startTransition(async () => {
      const result = await disconnectGmail();
      if (result.success) {
        toastSuccess("Gmail disconnected");
        router.refresh();
      } else {
        toastError(result.message);
      }
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gmail</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {errorMessage && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
        {justConnected && !errorMessage && (
          <Alert role="status">
            <AlertDescription>Gmail connected.</AlertDescription>
          </Alert>
        )}

        {!configured && (
          <div>
            <p className="font-medium">Gmail is not configured</p>
            <p className="text-muted-foreground">Set these environment variables:</p>
            <ul className="list-disc pl-5 font-mono text-xs">
              {missingEnv.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}

        {account ? (
          <>
            <p>
              Connected as <span className="font-medium break-all">{account.email}</span>
            </p>
            <ul className="list-disc pl-5 text-muted-foreground break-all">
              {account.scopes
                .split(/\s+/)
                .filter(Boolean)
                .map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
            </ul>
            <div>
              <Button variant="outline" onClick={disconnect} disabled={pending}>
                Disconnect
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">Gmail is not connected.</p>
            <div>
              {configured ? (
                <Button asChild>
                  <a href="/api/cockpit/gmail/connect">Connect Gmail</a>
                </Button>
              ) : (
                <Button disabled>Connect Gmail</Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
