import React, { useEffect, useState } from "react";
import System from "../../../models/system";
import { API_BASE, AUTH_TOKEN, AUTH_USER } from "../../../utils/constants";
import paths from "../../../utils/paths";
import showToast from "@/utils/toast";
import Modal from "@/components/lib/Modal";
import { useModal } from "@/hooks/useModal";
import RecoveryCodeModal from "@/components/Modals/DisplayRecoveryCodeModal";
import { useTranslation } from "react-i18next";
import { t } from "i18next";
import PasswordInput from "@/components/lib/PasswordInput";

const LARK_LOGIN_ERRORS = {
  tenant: {
    title: "Company not allowed",
    message:
      "This Lark account belongs to a different company. Sign in with your company account or use your password.",
  },
  denied: {
    title: "Access denied",
    message: "Lark sign-in was cancelled. Try again when you are ready.",
  },
  suspended: {
    title: "Account suspended",
    message: "Your AnythingLLM account is suspended. Contact an administrator.",
  },
  link_conflict: {
    title: "Account already linked",
    message:
      "This Lark account is connected to another user. Sign in to that account or contact an administrator.",
  },
  unknown: {
    title: "Lark sign-in failed",
    message:
      "Something went wrong while completing sign-in. Try again or use your password.",
  },
};

const RecoveryForm = ({ onSubmit, setShowRecoveryForm }) => {
  const [username, setUsername] = useState("");
  const [recoveryCodeInputs, setRecoveryCodeInputs] = useState(
    Array(2).fill("")
  );

  const handleRecoveryCodeChange = (index, value) => {
    const updatedCodes = [...recoveryCodeInputs];
    updatedCodes[index] = value;
    setRecoveryCodeInputs(updatedCodes);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const recoveryCodes = recoveryCodeInputs.filter(
      (code) => code.trim() !== ""
    );
    onSubmit(username, recoveryCodes);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col justify-center items-center"
    >
      <div className="flex items-start justify-between pt-7 pb-9">
        <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
          <div className="flex gap-x-1">
            <h3 className="text-white light:text-slate-950 text-3xl leading-[28px] font-medium text-center white-space-nowrap block">
              {t("login.password-reset.title")}
            </h3>
          </div>
          <p className="text-zinc-400 light:text-zinc-600 text-sm text-center">
            {t("login.password-reset.description")}
          </p>
        </div>
      </div>
      <div className="w-full px-12">
        <div className="w-full flex flex-col gap-y-3">
          <div className="w-full flex flex-col gap-y-2">
            <label className="text-zinc-300 light:text-slate-800 text-sm">
              {t("login.multi-user.placeholder-username")}
            </label>
            <input
              name="username"
              type="text"
              className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="off"
            />
          </div>
          <div className="w-full flex flex-col gap-y-2">
            <label className="text-zinc-300 light:text-slate-800 text-sm">
              {t("login.password-reset.recovery-codes")}
            </label>
            {recoveryCodeInputs.map((code, index) => (
              <input
                key={index}
                type="text"
                name={`recoveryCode${index + 1}`}
                className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
                value={code}
                onChange={(e) =>
                  handleRecoveryCodeChange(index, e.target.value)
                }
                required
                autoComplete="off"
              />
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center px-12 mt-9 space-x-2 w-full flex-col gap-y-6">
        <button
          type="submit"
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full"
        >
          {t("login.password-reset.title")}
        </button>
        <button
          type="button"
          className="text-zinc-200 light:text-zinc-600 hover:text-sky-300 light:hover:text-sky-600 hover:underline text-sm flex gap-x-1"
          onClick={() => setShowRecoveryForm(false)}
        >
          {t("login.password-reset.back-to-login")}
        </button>
      </div>
    </form>
  );
};

const ResetPasswordForm = ({ onSubmit }) => {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(newPassword, confirmPassword);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col justify-center items-center"
    >
      <div className="flex items-start justify-between pt-7 pb-9">
        <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
          <div className="flex gap-x-1">
            <h3 className="text-white light:text-slate-950 text-[38px] leading-[28px] font-medium text-center white-space-nowrap block">
              Reset Password
            </h3>
          </div>
          <p className="text-zinc-400 light:text-zinc-600 text-sm text-center">
            Enter your new password.
          </p>
        </div>
      </div>
      <div className="w-full px-12">
        <div className="w-full flex flex-col gap-y-3">
          <div className="w-full flex flex-col gap-y-2">
            <label className="text-zinc-300 light:text-slate-800 text-sm">
              New Password
            </label>
            <PasswordInput
              name="newPassword"
              containerClassName="w-[300px]"
              className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-full h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>
          <div className="w-full flex flex-col gap-y-2">
            <label className="text-zinc-300 light:text-slate-800 text-sm">
              Confirm Password
            </label>
            <PasswordInput
              name="confirmPassword"
              containerClassName="w-[300px]"
              className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-full h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
        </div>
      </div>
      <div className="flex items-center px-12 mt-9 space-x-2 w-full flex-col gap-y-6">
        <button
          type="submit"
          className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full"
        >
          Reset Password
        </button>
      </div>
    </form>
  );
};

export default function MultiUserAuth() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [downloadComplete, setDownloadComplete] = useState(false);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [showRecoveryForm, setShowRecoveryForm] = useState(false);
  const [showResetPasswordForm, setShowResetPasswordForm] = useState(false);
  const [customAppName, setCustomAppName] = useState(null);
  const [larkLoginEnabled, setLarkLoginEnabled] = useState(false);
  const larkError =
    LARK_LOGIN_ERRORS[
      new URLSearchParams(window.location.search).get("lark_error")
    ] || null;

  const {
    isOpen: isRecoveryCodeModalOpen,
    openModal: openRecoveryCodeModal,
    closeModal: closeRecoveryCodeModal,
  } = useModal();

  const handleLogin = async (e) => {
    setError(null);
    setLoading(true);
    e.preventDefault();
    const data = {};
    const form = new FormData(e.target);
    for (var [key, value] of form.entries()) data[key] = value;
    const { valid, user, token, message, recoveryCodes } =
      await System.requestToken(data);
    if (valid && !!token && !!user) {
      setUser(user);
      setToken(token);

      if (recoveryCodes) {
        setRecoveryCodes(recoveryCodes);
        openRecoveryCodeModal();
      } else {
        window.localStorage.setItem(AUTH_USER, JSON.stringify(user));
        window.localStorage.setItem(AUTH_TOKEN, token);
        window.location = paths.home();
      }
    } else {
      setError(message);
      setLoading(false);
    }
    setLoading(false);
  };

  const handleDownloadComplete = () => setDownloadComplete(true);
  const handleResetPassword = () => setShowRecoveryForm(true);
  const handleRecoverySubmit = async (username, recoveryCodes) => {
    const { success, resetToken, error } = await System.recoverAccount(
      username,
      recoveryCodes
    );

    if (success && resetToken) {
      window.localStorage.setItem("resetToken", resetToken);
      setShowRecoveryForm(false);
      setShowResetPasswordForm(true);
    } else {
      showToast(error, "error", { clear: true });
    }
  };

  const handleResetSubmit = async (newPassword, confirmPassword) => {
    const resetToken = window.localStorage.getItem("resetToken");

    if (resetToken) {
      const { success, error } = await System.resetPassword(
        resetToken,
        newPassword,
        confirmPassword
      );

      if (success) {
        window.localStorage.removeItem("resetToken");
        setShowResetPasswordForm(false);
        showToast("Password reset successful", "success", { clear: true });
      } else {
        showToast(error, "error", { clear: true });
      }
    } else {
      showToast("Invalid reset token", "error", { clear: true });
    }
  };

  useEffect(() => {
    if (downloadComplete && user && token) {
      window.localStorage.setItem(AUTH_USER, JSON.stringify(user));
      window.localStorage.setItem(AUTH_TOKEN, token);
      window.location = paths.home();
    }
  }, [downloadComplete, user, token]);

  useEffect(() => {
    const fetchLoginSettings = async () => {
      const [app, settings] = await Promise.all([
        System.fetchCustomAppName(),
        System.keys(),
      ]);
      setCustomAppName(app?.appName || "");
      setLarkLoginEnabled(
        Boolean(settings?.MultiUserMode && settings?.LarkLoginEnabled)
      );
      setLoading(false);
    };
    fetchLoginSettings();
  }, []);

  if (showRecoveryForm) {
    return (
      <RecoveryForm
        onSubmit={handleRecoverySubmit}
        setShowRecoveryForm={setShowRecoveryForm}
      />
    );
  }

  if (showResetPasswordForm)
    return <ResetPasswordForm onSubmit={handleResetSubmit} />;
  return (
    <>
      <form
        onSubmit={handleLogin}
        className="flex flex-col justify-center items-center"
      >
        <div className="flex items-start justify-between pt-7 pb-9">
          <div className="flex items-center flex-col gap-y-[18px] max-w-[300px]">
            <div className="flex gap-x-1">
              <h3 className="text-white light:text-slate-950 text-[38px] leading-[28px] font-medium text-center white-space-nowrap block">
                {t("login.multi-user.welcome")}
              </h3>
            </div>
            <p className="text-zinc-400 light:text-zinc-600 text-sm text-center">
              {t("login.sign-in", { appName: customAppName || "AnythingLLM" })}
            </p>
          </div>
        </div>
        <div className="w-full px-12">
          {larkError && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200 light:text-red-700"
            >
              <strong className="block font-semibold">{larkError.title}</strong>
              <span>{larkError.message}</span>
            </div>
          )}
          <div className="w-full flex flex-col gap-y-3">
            <div className="w-full flex flex-col gap-y-2">
              <label className="text-zinc-300 light:text-slate-800 text-sm">
                {t("login.multi-user.placeholder-username")}
              </label>
              <input
                name="username"
                type="text"
                className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-[300px] h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
                required={true}
                autoComplete="off"
              />
            </div>
            <div className="w-full px-0 flex flex-col gap-y-2">
              <label className="text-zinc-300 light:text-slate-800 text-sm">
                {t("login.multi-user.placeholder-password")}
              </label>
              <PasswordInput
                name="password"
                containerClassName="w-[300px]"
                className="border-none bg-zinc-800 light:bg-slate-200 text-zinc-200 light:text-zinc-600 text-sm rounded-lg p-2.5 w-full h-[34px] focus:outline-none focus:ring-1 focus:ring-sky-300"
                required={true}
                autoComplete="off"
              />
            </div>
            {error && <p className="text-red-400 text-sm">Error: {error}</p>}
          </div>
        </div>
        <div className="flex items-center px-12 mt-9 space-x-2 w-full flex-col gap-y-6">
          <button
            disabled={loading}
            type="submit"
            className="text-zinc-950 bg-white hover:bg-zinc-300 light:bg-sky-200 light:text-slate-950 light:hover:bg-sky-300 text-sm font-semibold rounded-lg border-primary-button h-[34px] w-full"
          >
            {loading
              ? t("login.multi-user.validating")
              : t("login.multi-user.login")}
          </button>
          {larkLoginEnabled && (
            <div className="flex w-full flex-col gap-y-4">
              <div className="flex items-center gap-x-3 text-xs text-zinc-500 light:text-zinc-500">
                <span className="h-px flex-1 bg-zinc-700 light:bg-slate-300" />
                or
                <span className="h-px flex-1 bg-zinc-700 light:bg-slate-300" />
              </div>
              <button
                type="button"
                onClick={() => {
                  window.location.href = `${API_BASE}/lark/auth/start`;
                }}
                className="flex h-[34px] w-full items-center justify-center gap-x-2 rounded-lg border border-zinc-700 bg-transparent text-sm font-semibold text-zinc-100 hover:bg-zinc-800 light:border-slate-300 light:text-slate-800 light:hover:bg-slate-100"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  aria-hidden="true"
                >
                  <rect
                    x="2"
                    y="2"
                    width="6"
                    height="6"
                    rx="1"
                    fill="#36bffa"
                  />
                  <rect
                    x="10"
                    y="2"
                    width="6"
                    height="6"
                    rx="1"
                    fill="#7cd4fd"
                  />
                  <rect
                    x="2"
                    y="10"
                    width="6"
                    height="6"
                    rx="1"
                    fill="#7cd4fd"
                  />
                  <rect
                    x="10"
                    y="10"
                    width="6"
                    height="6"
                    rx="1"
                    fill="#36bffa"
                  />
                </svg>
                Login with Lark
              </button>
            </div>
          )}
          <button
            type="button"
            className="text-zinc-200 light:text-zinc-600 hover:text-sky-300 light:hover:text-sky-600 hover:underline text-sm flex gap-x-1"
            onClick={handleResetPassword}
          >
            {t("login.multi-user.forgot-pass")}?
            <b className="font-semibold text-sky-300 light:text-sky-600">
              {t("login.multi-user.reset")}
            </b>
          </button>
        </div>
      </form>

      <Modal
        isOpen={isRecoveryCodeModalOpen}
        noPortal={true}
        onClose={closeRecoveryCodeModal}
      >
        <RecoveryCodeModal
          recoveryCodes={recoveryCodes}
          onDownloadComplete={handleDownloadComplete}
          onClose={closeRecoveryCodeModal}
        />
      </Modal>
    </>
  );
}
