const crypto = require('crypto');
const { Resend } = require('resend');
const StaffInvite = require('../models/StaffInvite');
const User = require('../models/User');

// ── Invite code generator ─────────────────────────────────────────────────────
// Format: DQ-XXXX-XXXX (e.g. DQ-A3FX-9K2M) — easy to read, easy to type
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 (confusing)
  const part = (len) => Array.from({ length: len }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `DQ-${part(4)}-${part(4)}`;
}

// ── Resend client ─────────────────────────────────────────────────────────────
function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// ── Email template ────────────────────────────────────────────────────────────
function buildInviteEmail({ name, storeName, token, expiresAt }) {
  const expiryStr = new Date(expiresAt).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  return {
    subject: `You've been invited to join ${storeName} on DQ`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:#1B5E20;padding:32px;text-align:center;">
            <div style="font-size:28px;font-weight:bold;color:#ffffff;letter-spacing:2px;">DQ</div>
            <div style="color:#A5D6A7;font-size:13px;margin-top:4px;">Digital Queue — Smart Retail</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 8px;font-size:16px;color:#111827;">Hi <strong>${name}</strong>,</p>
            <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">
              You've been invited to join <strong>${storeName}</strong> as a staff member on the DQ platform.
            </p>

            <p style="margin:0 0 12px;font-size:14px;color:#6B7280;">Your invite code:</p>

            <!-- Invite Code Box -->
            <div style="background:#F0FDF4;border:2px dashed #4CAF50;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
              <div style="font-size:28px;font-weight:bold;color:#1B5E20;letter-spacing:4px;">${token}</div>
              <div style="font-size:12px;color:#6B7280;margin-top:8px;">Valid until ${expiryStr}</div>
            </div>

            <p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">How to join:</p>
            <ol style="margin:0 0 24px;padding-left:20px;color:#374151;font-size:14px;line-height:2;">
              <li>Download the <strong>DQ Staff</strong> app on your Android phone</li>
              <li>Sign up or log in with this email address</li>
              <li>Enter the invite code above when prompted</li>
              <li>You're in — start managing orders!</li>
            </ol>

            <p style="margin:0;font-size:12px;color:#9CA3AF;">
              This invite expires on ${expiryStr}. If you did not expect this email, you can safely ignore it.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#F9FAFB;padding:20px;text-align:center;border-top:1px solid #E5E7EB;">
            <p style="margin:0;font-size:12px;color:#9CA3AF;">
              Sent by DQ Store · <a href="https://dqstore.in" style="color:#4CAF50;text-decoration:none;">dqstore.in</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
  };
}

// ── Service functions ─────────────────────────────────────────────────────────

async function inviteStaff({ email, name, storeId, storeName }) {
  // Check for existing unused invite for same email+store
  const existing = await StaffInvite.findOne({ email, storeId, used: false, expiresAt: { $gt: new Date() } });
  if (existing) {
    throw new Error(`An active invite already exists for ${email}. It expires on ${existing.expiresAt.toLocaleDateString('en-IN')}.`);
  }

  const token = generateInviteCode();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

  const invite = await StaffInvite.create({ email, name, storeId, storeName, token, expiresAt });

  // Send via Resend (fire-and-forget)
  if (process.env.RESEND_API_KEY) {
    const resend = getResend();
    const { subject, html } = buildInviteEmail({ name, storeName, token, expiresAt });
    resend.emails.send({
      from: 'DQ Store <noreply@dqstore.in>',
      to: email,
      subject,
      html,
    }).then(r => console.log(`[Invite] Email sent to ${email}:`, r.id))
      .catch(err => console.error('[Invite] Email failed:', err.message));
  } else {
    console.log(`[Invite] Resend not configured. Token for ${email}: ${token}`);
  }

  return invite;
}

async function bulkInviteStaff({ invites, storeId, storeName }) {
  const results = [];
  for (const { email, name } of invites) {
    try {
      const invite = await inviteStaff({ email, name, storeId, storeName });
      results.push(invite);
    } catch (err) {
      // Skip duplicates, continue with rest
      console.warn(`Skipped invite for ${email}: ${err.message}`);
    }
  }
  return results;
}

async function validateInviteToken(token) {
  const invite = await StaffInvite.findOne({ token });
  if (!invite) throw new Error('Invalid invite code. Please check and try again.');
  if (invite.used) throw new Error('This invite code has already been used.');
  if (invite.expiresAt < new Date()) throw new Error('This invite code has expired. Ask your store admin to send a new one.');
  return invite;
}

async function acceptInvite({ token, uid }) {
  const invite = await validateInviteToken(token);

  // Add 'staff' role without removing existing roles (customer stays intact)
  const user = await User.findOneAndUpdate(
    { firebase_uid: uid },
    { $addToSet: { roles: 'staff' }, $set: { storeId: invite.storeId } },
    { new: true }
  );
  if (!user) throw new Error('User not found. Please sign in and try again.');

  // Mark invite as used
  await StaffInvite.findByIdAndUpdate(invite._id, { used: true, usedAt: new Date() });

  return user;
}

async function getStoreStaff(storeId) {
  return User.find({ storeId, roles: { $in: ['staff', 'admin'] } }).sort({ name: 1 });
}

async function removeStaff(userId) {
  // Pull staff role, keep customer role, clear storeId
  await User.findByIdAndUpdate(userId, {
    $pull: { roles: 'staff' },
    $set: { storeId: null },
  });
  return true;
}

async function getPendingInvites(storeId) {
  return StaffInvite.find({ storeId, used: false, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
}

async function cancelInvite(inviteId) {
  await StaffInvite.findByIdAndDelete(inviteId);
  return true;
}

module.exports = {
  inviteStaff,
  bulkInviteStaff,
  validateInviteToken,
  acceptInvite,
  getStoreStaff,
  removeStaff,
  getPendingInvites,
  cancelInvite,
};
