"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { disconnectGmail } from "@/actions/cockpitGmail.actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { REQUEST_FAILED } from "./runAction";

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
      try {
        const result = await disconnectGmail();
        if (result.success) {
          toastSuccess("Gmail disconnected");
          router.refresh();
        } else {
          toastError(result.message);
        }
      } catch {
        toastError(REQUEST_FAILED);
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
        {/* ?connected=1 survives router.refresh(): not after a Disconnect. */}
        {justConnected && account && !errorMessage && (
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
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={pending}>
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect Gmail?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {`This revokes the access of the cockpit to ${account.email}. Sending is not possible until you connect again and approve the access on the Google consent screen.`}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={disconnect}>Disconnect</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
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
