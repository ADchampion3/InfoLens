import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertCircle, CalendarClock, CheckCircle2, Clock, History, LoaderCircle, Mail, Pause,
  Pencil, Play, Plus, RefreshCw, Save, Send, Trash2, X,
} from "lucide-react";
import { runtimeRequest } from "./runtime-api";
import { useLanguage } from "./i18n";

interface AutomationPageProps {
  runtime: RuntimeInfo;
  onNotice: (notice: string) => void;
}

interface AutomationForm {
  kind: AutomationScheduleKind;
  name: string;
  pluginId: string;
  pluginIds: string[];
  intervalMinutes: number;
  cadence: "daily" | "weekly";
  time: string;
  weekdays: number[];
  timeZone: string;
  recipients: string;
}

interface MailForm {
  host: string;
  port: number;
  security: "starttls" | "tls";
  username: string;
  from: string;
  password: string;
  testRecipient: string;
}

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

function newOperationId() {
  return globalThis.crypto?.randomUUID?.() ?? "automation-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function failureMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Automation request failed.";
}

function formatInstant(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function scheduleLabel(schedule: AutomationSchedule) {
  if (schedule.kind === "refresh") {
    const spec = schedule.spec.type === "interval" ? schedule.spec.intervalMinutes + " min" : "interval";
    return "Refresh · " + spec;
  }
  if (schedule.spec.type === "weekly") return "Daily digest · weekly at " + schedule.spec.time;
  if (schedule.spec.type === "daily") return "Daily digest · daily at " + schedule.spec.time;
  return "Daily digest";
}

function schedulePayload(schedule: AutomationSchedule, state?: AutomationSchedule["state"]) {
  return {
    kind: schedule.kind,
    ...(schedule.name ? { name: schedule.name } : {}),
    ...(schedule.pluginId ? { pluginId: schedule.pluginId } : {}),
    ...(schedule.pluginIds ? { pluginIds: schedule.pluginIds } : {}),
    spec: schedule.spec,
    timeZone: schedule.timeZone,
    ...(schedule.recipients ? { recipients: schedule.recipients } : {}),
    ...(state ? { state } : {}),
    version: schedule.version,
  };
}

function initialForm(runtime: RuntimeInfo, timeZone: string) {
  return {
    kind: "refresh" as AutomationScheduleKind,
    name: "",
    pluginId: runtime.plugins[0]?.id ?? "",
    pluginIds: runtime.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
    intervalMinutes: 60,
    cadence: "daily" as const,
    time: "08:00",
    weekdays: [1, 2, 3, 4, 5],
    timeZone,
    recipients: "",
  };
}

function payloadFromForm(form: AutomationForm): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: form.kind,
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    timeZone: form.timeZone.trim(),
  };
  if (form.kind === "refresh") {
    return {
      ...base,
      pluginId: form.pluginId,
      spec: { type: "interval", intervalMinutes: Number(form.intervalMinutes) },
    };
  }
  const recipients = form.recipients.split(/[\s,;]+/u).map((value) => value.trim()).filter(Boolean);
  return {
    ...base,
    pluginIds: form.pluginIds,
    spec: form.cadence === "weekly"
      ? { type: "weekly", time: form.time, weekdays: form.weekdays }
      : { type: "daily", time: form.time },
    recipients,
  };
}

export function AutomationPage({ runtime, onNotice }: AutomationPageProps) {
  const { t } = useLanguage();
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const [schedules, setSchedules] = useState<AutomationSchedule[]>([]);
  const [mail, setMail] = useState<AutomationMailSettings>({ configured: false, version: 0, hasPassword: false });
  const [form, setForm] = useState<AutomationForm>(() => initialForm(runtime, defaultZone));
  const [mailForm, setMailForm] = useState<MailForm>({
    host: "",
    port: 587,
    security: "starttls",
    username: "",
    from: "",
    password: "",
    testRecipient: "",
  });
  const [editingId, setEditingId] = useState<string>();
  const [runs, setRuns] = useState<Record<string, AutomationRun[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [mailTest, setMailTest] = useState<AutomationMailTest>();

  const loadData = useCallback(async () => {
    const currentRuntime = runtimeRef.current;
    try {
      const response = await runtimeRequest<{
        schedules: AutomationSchedule[];
        defaultTimeZone?: string | null;
        mail: AutomationMailSettings;
      }>(currentRuntime, "/api/v1/schedules");
      setSchedules(response.schedules);
      setMail(response.mail);
      const zone = response.defaultTimeZone || defaultZone;
      setForm((current) => ({ ...current, timeZone: current.timeZone || zone }));
      setMailForm((current) => ({
        ...current,
        host: response.mail.host ?? current.host,
        port: response.mail.port ?? current.port,
        security: response.mail.security ?? current.security,
        username: response.mail.username ?? current.username,
        from: response.mail.from ?? current.from,
      }));
      setError(undefined);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [defaultZone]);

  useEffect(() => {
    void loadData();
  }, [loadData, runtime.origin]);

  const updateForm = <K extends keyof AutomationForm>(key: K, value: AutomationForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const editSchedule = (schedule: AutomationSchedule) => {
    const spec = schedule.spec;
    setEditingId(schedule.scheduleId);
    setForm({
      kind: schedule.kind,
      name: schedule.name ?? "",
      pluginId: schedule.pluginId ?? "",
      pluginIds: schedule.pluginIds ?? [],
      intervalMinutes: spec.type === "interval" ? spec.intervalMinutes : 60,
      cadence: spec.type === "weekly" ? "weekly" : "daily",
      time: spec.type === "interval" ? "08:00" : spec.time,
      weekdays: spec.type === "weekly" ? spec.weekdays : [1, 2, 3, 4, 5],
      timeZone: schedule.timeZone,
      recipients: schedule.recipients?.join(", ") ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const resetForm = () => {
    setEditingId(undefined);
    setForm(initialForm(runtimeRef.current, form.timeZone || defaultZone));
  };

  const saveSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.kind === "refresh" && !form.pluginId) {
      setError("Choose a Plugin for the refresh schedule.");
      return;
    }
    if (form.kind === "daily_digest" && !form.pluginIds.length) {
      setError("Choose at least one Plugin for the Daily Summary.");
      return;
    }
    const current = schedules.find((schedule) => schedule.scheduleId === editingId);
    const payload = payloadFromForm(form);
    if (current) payload.version = current.version;
    const key = current ? "update-schedule" : "create-schedule";
    setBusy(key);
    try {
      await runtimeRequest(runtimeRef.current, current
        ? "/api/v1/schedules/" + encodeURIComponent(current.scheduleId)
        : "/api/v1/schedules", {
        method: current ? "PATCH" : "POST",
        headers: { "x-infolens-operation-id": newOperationId() },
        body: JSON.stringify(payload),
      });
      await loadData();
      resetForm();
      onNotice(current ? "Schedule updated." : "Schedule created.");
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const patchSchedule = async (schedule: AutomationSchedule, state: AutomationSchedule["state"]) => {
    setBusy("state-" + schedule.scheduleId);
    try {
      await runtimeRequest(runtimeRef.current, "/api/v1/schedules/" + encodeURIComponent(schedule.scheduleId), {
        method: "PATCH",
        headers: { "x-infolens-operation-id": newOperationId() },
        body: JSON.stringify(schedulePayload(schedule, state)),
      });
      await loadData();
      onNotice(state === "enabled" ? "Schedule enabled." : "Schedule paused.");
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const deleteSchedule = async (schedule: AutomationSchedule) => {
    setBusy("delete-" + schedule.scheduleId);
    try {
      await runtimeRequest(runtimeRef.current, "/api/v1/schedules/" + encodeURIComponent(schedule.scheduleId), {
        method: "DELETE",
        headers: { "x-infolens-operation-id": newOperationId() },
      });
      await loadData();
      if (editingId === schedule.scheduleId) resetForm();
      onNotice("Schedule deleted.");
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const runNow = async (schedule: AutomationSchedule) => {
    setBusy("run-" + schedule.scheduleId);
    try {
      await runtimeRequest(runtimeRef.current, "/api/v1/schedules/" + encodeURIComponent(schedule.scheduleId) + "/run", {
        method: "POST",
        headers: { "x-infolens-operation-id": newOperationId() },
      });
      onNotice("Run queued.");
      window.setTimeout(() => { void loadData(); }, 700);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const loadRuns = async (schedule: AutomationSchedule, force = false) => {
    if (runs[schedule.scheduleId] && !force) {
      setRuns((current) => {
        const next = { ...current };
        delete next[schedule.scheduleId];
        return next;
      });
      return;
    }
    setBusy("history-" + schedule.scheduleId);
    try {
      const response = await runtimeRequest<{ runs: AutomationRun[] }>(
        runtimeRef.current,
        "/api/v1/schedules/" + encodeURIComponent(schedule.scheduleId) + "/runs?limit=20",
      );
      setRuns((current) => ({ ...current, [schedule.scheduleId]: response.runs }));
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const resend = async (schedule: AutomationSchedule, run: AutomationRun) => {
    setBusy("resend-" + run.runId);
    try {
      await runtimeRequest(runtimeRef.current, "/api/v1/schedules/" + encodeURIComponent(schedule.scheduleId) + "/runs/" + encodeURIComponent(run.runId) + "/resend", {
        method: "POST",
        headers: { "x-infolens-operation-id": newOperationId() },
      });
      onNotice("Digest resend queued.");
      await loadRuns(schedule, true);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const saveMail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("save-mail");
    try {
      const body = {
        host: mailForm.host,
        port: Number(mailForm.port),
        security: mailForm.security,
        username: mailForm.username,
        from: mailForm.from,
        version: mail.version,
        ...(mailForm.password ? { password: mailForm.password } : {}),
      };
      await runtimeRequest(runtimeRef.current, "/api/v1/mail-settings", {
        method: "PUT",
        headers: { "x-infolens-operation-id": newOperationId() },
        body: JSON.stringify(body),
      });
      setMailForm((current) => ({ ...current, password: "" }));
      await loadData();
      onNotice("Mail settings saved.");
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const testMail = async () => {
    setBusy("test-mail");
    try {
      const response = await runtimeRequest<{ mailTest: AutomationMailTest }>(runtimeRef.current, "/api/v1/mail-test", {
        method: "POST",
        headers: { "x-infolens-operation-id": newOperationId() },
        body: JSON.stringify({ recipients: mailForm.testRecipient }),
      });
      setMailTest(response.mailTest);
      onNotice(response.mailTest.state === "sent" ? "Test mail sent." : "Test mail result: " + response.mailTest.state);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  const pluginNames = useMemo(() => new Map(runtime.plugins.map((plugin) => [plugin.id, plugin.name])), [runtime.plugins]);

  return (
    <section className="host-page automation-page">
      <header className="page-header">
        <div>
          <p className="eyebrow"><CalendarClock size={14} /> {t("Daemon automation")}</p>
          <h1>{t("Automation")}</h1>
          <p>{t("Schedules run in the daemon, even when this window is closed.")}</p>
        </div>
        <div className="page-header-actions">
          <button type="button" onClick={() => void loadData()} disabled={loading}><RefreshCw size={16} />{t("Refresh")}</button>
          <button type="button" className="primary-button" onClick={resetForm}><Plus size={16} />{t("New schedule")}</button>
        </div>
      </header>

      {error && <div className="automation-alert automation-alert--error" role="alert"><AlertCircle size={16} /><span>{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError(undefined)}><X size={15} /></button></div>}

      <div className="automation-layout">
        <div className="automation-main">
          <section className="automation-section">
            <div className="automation-section-head"><div><span className="section-kicker">{editingId ? "EDIT SCHEDULE" : "NEW SCHEDULE"}</span><h2>{editingId ? "Edit schedule" : "Create a schedule"}</h2></div>{editingId && <button type="button" onClick={resetForm}><X size={15} />Cancel edit</button>}</div>
            <form className="automation-form" onSubmit={(event) => void saveSchedule(event)}>
              <div className="automation-form-grid">
                <label><span>Task type</span><select value={form.kind} onChange={(event) => updateForm("kind", event.target.value as AutomationScheduleKind)}><option value="refresh">Refresh a Plugin</option><option value="daily_digest">Email Daily Summary</option></select></label>
                <label><span>Name</span><input value={form.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="Optional label" maxLength={120} /></label>
                <label><span>Time zone</span><input value={form.timeZone} onChange={(event) => updateForm("timeZone", event.target.value)} placeholder="America/Los_Angeles" required /></label>
                {form.kind === "refresh" && <label><span>Plugin</span><select value={form.pluginId} onChange={(event) => updateForm("pluginId", event.target.value)} required><option value="">Choose a Plugin</option>{runtime.plugins.map((plugin) => <option key={plugin.id} value={plugin.id}>{plugin.name} · {plugin.state}</option>)}</select></label>}
                {form.kind === "refresh" && <label><span>Every (5 min to 7 days)</span><input type="number" min={5} max={10080} step={1} value={form.intervalMinutes} onChange={(event) => updateForm("intervalMinutes", Number(event.target.value))} required /></label>}
                {form.kind === "daily_digest" && <label><span>Cadence</span><select value={form.cadence} onChange={(event) => updateForm("cadence", event.target.value as "daily" | "weekly")}><option value="daily">Every day</option><option value="weekly">Selected weekdays</option></select></label>}
                {form.kind === "daily_digest" && <label><span>Local time</span><input type="time" value={form.time} onChange={(event) => updateForm("time", event.target.value)} required /></label>}
              </div>
              {form.kind === "daily_digest" && <div className="automation-subform">
                <fieldset><legend>Daily Summary Plugins</legend><div className="automation-check-grid">{runtime.plugins.map((plugin) => <label key={plugin.id}><input type="checkbox" checked={form.pluginIds.includes(plugin.id)} onChange={(event) => updateForm("pluginIds", event.target.checked ? [...form.pluginIds, plugin.id] : form.pluginIds.filter((id) => id !== plugin.id))} /><span>{plugin.name}</span></label>)}</div></fieldset>
                {form.cadence === "weekly" && <fieldset><legend>Weekdays</legend><div className="automation-weekdays">{WEEKDAYS.map((day) => <label key={day.value} className={form.weekdays.includes(day.value) ? "is-selected" : ""}><input type="checkbox" checked={form.weekdays.includes(day.value)} onChange={(event) => updateForm("weekdays", event.target.checked ? [...form.weekdays, day.value].sort() : form.weekdays.filter((value) => value !== day.value))} /><span>{day.label}</span></label>)}</div></fieldset>}
                <label><span>To recipients</span><input value={form.recipients} onChange={(event) => updateForm("recipients", event.target.value)} placeholder="you@example.com, team@example.com" required /></label>
              </div>}
              <div className="automation-form-actions"><button type="submit" className="primary-button" disabled={Boolean(busy)}>{busy === "create-schedule" || busy === "update-schedule" ? <LoaderCircle className="spinner" size={15} /> : editingId ? <Save size={15} /> : <Plus size={15} />}{editingId ? "Save schedule" : "Create schedule"}</button>{editingId && <button type="button" onClick={resetForm}>Clear</button>}</div>
            </form>
          </section>

          <section className="automation-section">
            <div className="automation-section-head"><div><span className="section-kicker">DAEMON SCHEDULES</span><h2>Scheduled work</h2></div><span className="automation-count">{schedules.length}</span></div>
            {loading && <div className="automation-empty"><LoaderCircle className="spinner" size={18} />Loading schedules…</div>}
            {!loading && !schedules.length && <div className="automation-empty"><Clock size={18} />No schedules configured.</div>}
            <div className="automation-schedule-list">
              {schedules.map((schedule) => {
                const scheduleRuns = runs[schedule.scheduleId];
                const pluginList = schedule.pluginIds?.map((id) => pluginNames.get(id) ?? id).join(", ");
                return <article className={"automation-card automation-card--" + schedule.state} key={schedule.scheduleId}>
                  <div className="automation-card-head"><div className="automation-card-title"><span className="automation-kind">{schedule.kind === "refresh" ? <RefreshCw size={14} /> : <Mail size={14} />}</span><div><h3>{schedule.name || scheduleLabel(schedule)}</h3><p>{schedule.kind === "refresh" ? pluginNames.get(schedule.pluginId ?? "") ?? schedule.pluginId : pluginList}</p></div></div><span className={"automation-state automation-state--" + schedule.state}>{schedule.state}</span></div>
                  <div className="automation-card-facts"><span><strong>Schedule</strong>{scheduleLabel(schedule)}</span><span><strong>Time zone</strong>{schedule.timeZone}</span><span><strong>Next run</strong>{schedule.state === "paused" ? "Paused" : formatInstant(schedule.nextRunAt)}</span><span><strong>Last run</strong>{formatInstant(schedule.lastDueAt)}</span></div>
                  {schedule.lastError && <div className="automation-card-error"><AlertCircle size={14} />{schedule.lastError.code}: {schedule.lastError.message}</div>}
                  <div className="automation-card-actions">
                    <button type="button" onClick={() => void runNow(schedule)} disabled={Boolean(busy)}><Play size={14} />Run now</button>
                    <button type="button" onClick={() => void patchSchedule(schedule, schedule.state === "enabled" ? "paused" : "enabled")} disabled={Boolean(busy) || schedule.state === "orphaned"}>{schedule.state === "enabled" ? <Pause size={14} /> : <Play size={14} />}{schedule.state === "enabled" ? "Pause" : "Enable"}</button>
                    <button type="button" onClick={() => editSchedule(schedule)}><Pencil size={14} />Edit</button>
                    <button type="button" onClick={() => void loadRuns(schedule)} disabled={busy === "history-" + schedule.scheduleId}><History size={14} />{scheduleRuns ? "Hide history" : "History"}</button>
                    <button type="button" className="danger-button" onClick={() => void deleteSchedule(schedule)} disabled={Boolean(busy)}><Trash2 size={14} />Delete</button>
                  </div>
                  {scheduleRuns && <div className="automation-run-list">{scheduleRuns.length === 0 && <span className="automation-muted">No runs yet.</span>}{scheduleRuns.map((run) => <div className="automation-run-row" key={run.runId}><span className={"automation-run-icon automation-run-icon--" + run.state}>{run.state === "succeeded" ? <CheckCircle2 size={14} /> : run.state === "failed" ? <AlertCircle size={14} /> : <Clock size={14} />}</span><span><strong>{run.state}</strong><small>{run.trigger}{run.periodKey ? " · " + run.periodKey : ""} · {formatInstant(run.createdAt)}</small>{run.delivery && <small>delivery: {run.delivery.state} · {run.delivery.attempts} attempt(s)</small>}{run.error && <small className="automation-card-error">{run.error.code}: {run.error.message}</small>}</span>{schedule.kind === "daily_digest" && run.snapshotId && <button type="button" onClick={() => void resend(schedule, run)} disabled={Boolean(busy)}><Send size={13} />Resend</button>}</div>)}</div>}
                </article>;
              })}
            </div>
          </section>
        </div>

        <aside className="automation-side">
          <section className="automation-section">
            <div className="automation-section-head"><div><span className="section-kicker">SMTP DELIVERY</span><h2><Mail size={17} /> Mail settings</h2></div></div>
            <form className="automation-form" onSubmit={(event) => void saveMail(event)}>
              <label><span>SMTP host</span><input value={mailForm.host} onChange={(event) => setMailForm((current) => ({ ...current, host: event.target.value }))} placeholder="smtp.example.com" required /></label>
              <div className="automation-form-grid automation-form-grid--two"><label><span>Security</span><select value={mailForm.security} onChange={(event) => { const security = event.target.value as "starttls" | "tls"; setMailForm((current) => ({ ...current, security, port: security === "tls" ? 465 : 587 })); }}><option value="starttls">STARTTLS</option><option value="tls">Implicit TLS</option></select></label><label><span>Port</span><input type="number" min={1} max={65535} value={mailForm.port} onChange={(event) => setMailForm((current) => ({ ...current, port: Number(event.target.value) }))} required /></label></div>
              <label><span>Username</span><input value={mailForm.username} onChange={(event) => setMailForm((current) => ({ ...current, username: event.target.value }))} required /></label>
              <label><span>Sender address</span><input type="email" value={mailForm.from} onChange={(event) => setMailForm((current) => ({ ...current, from: event.target.value }))} placeholder="infolens@example.com" required /></label>
              <label><span>Password {mail.hasPassword ? "(saved; leave blank to keep)" : ""}</span><input type="password" value={mailForm.password} onChange={(event) => setMailForm((current) => ({ ...current, password: event.target.value }))} autoComplete="new-password" /></label>
              <div className="automation-form-actions"><button type="submit" className="primary-button" disabled={busy === "save-mail"}>{busy === "save-mail" ? <LoaderCircle className="spinner" size={15} /> : <Save size={15} />}Save mail settings</button></div>
            </form>
            <div className="automation-test-mail"><label><span>Test recipient</span><input type="email" value={mailForm.testRecipient} onChange={(event) => setMailForm((current) => ({ ...current, testRecipient: event.target.value }))} placeholder={mailForm.from || "you@example.com"} /></label><button type="button" onClick={() => void testMail()} disabled={busy === "test-mail" || !mailForm.testRecipient}><Send size={14} />Send test mail</button>{mailTest && <p className={"automation-test-result automation-test-result--" + mailTest.state}>{mailTest.state}{mailTest.error ? ": " + mailTest.error.message : ""}</p>}</div>
          </section>
          <div className="automation-note"><CalendarClock size={17} /><span><strong>Daemon-owned scheduling</strong>Schedules, run history, digest snapshots, and delivery state live with the daemon. The Host Shell can close without stopping the schedule.</span></div>
        </aside>
      </div>
    </section>
  );
}
