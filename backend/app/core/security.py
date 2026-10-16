import jwt
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import uuid
import threading

from app.database import get_db
from app.models.profile import Profile
from app.config import settings

security = HTTPBearer(auto_error=False)

import logging

logger = logging.getLogger("eve.security")

_migration_lock = threading.Lock()

# Initialize JWKS Client if URL is provided
jwks_client = None
if settings.SUPABASE_URL:
    try:
        from jwt import PyJWKClient
        jwks_url = f"{settings.SUPABASE_URL}/auth/v1/.well-known/jwks.json"
        jwks_client = PyJWKClient(jwks_url, cache_keys=True)
        logger.info(f"Initialized PyJWKClient with URL: {jwks_url}")
    except ImportError:
        logger.warning("cryptography or PyJWKClient not available")

def verify_supabase_token(request: Request = None, credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    token = credentials.credentials if credentials else None
    
    path = request.url.path if request else ""
    if path.endswith("/api/profile/me"):
        logger.info("START profile/me")
    elif path.endswith("/api/organization/workspaces"):
        logger.info("START organization/workspaces")

    if credentials is None:
        logger.warning("Authentication credentials missing")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication credentials were not provided.",
            headers={"WWW-Authenticate": "Bearer"},
        )
        
    # Mock token is ONLY permitted in non-production environments (local dev / CI).
    # In production this bypass is disabled unconditionally to prevent unauthenticated access.
    if token == "mock-token" and settings.ENVIRONMENT not in ("production", "prod"):
        return {"sub": "00000000-0000-0000-0000-000000000000", "email": "mock@test.com"}

    try:
        # Debug: Print unverified token to see what claims are present
        unverified_payload = jwt.decode(token, options={"verify_signature": False})
        logger.debug(f"Unverified JWT Payload: {unverified_payload}")
        
        # Get token header to check algorithm
        header = jwt.get_unverified_header(token)
        alg = header.get("alg")
        
        # 1. Attempt JWKS Asymmetric Verification (for ES256/RS256)
        if alg in ["RS256", "ES256"] and jwks_client:
            try:
                signing_key = jwks_client.get_signing_key_from_jwt(token)
                payload = jwt.decode(
                    token,
                    signing_key.key,
                    algorithms=["RS256", "ES256"],
                    audience="authenticated"
                )
                logger.info(f"JWT Validation Success (JWKS) for user: {payload.get('sub')}")
                if path.endswith("/api/profile/me"):
                    logger.info("JWT verified")
                return payload
            except Exception as e:
                logger.warning(f"JWKS validation failed, falling back to HS256: {e}")

        # 2. Attempt Symmetric HS256 Verification (Legacy/Default Supabase)
        try:
            if not settings.SUPABASE_JWT_SECRET:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication service is not configured.", headers={"WWW-Authenticate": "Bearer"})
            payload = jwt.decode(
                token,
                settings.SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                audience="authenticated"
            )
        except jwt.InvalidSignatureError:
            import base64
            # If signature validation fails, it's highly likely it requires base64 decoding
            decoded_secret = base64.b64decode(settings.SUPABASE_JWT_SECRET)
            payload = jwt.decode(
                token,
                decoded_secret,
                algorithms=["HS256"],
                audience="authenticated"
            )
            
        logger.info(f"JWT Validation Success (HS256) for user: {payload.get('sub')}")
        if path.endswith("/api/profile/me"):
            logger.info("JWT verified")
        return payload
    except HTTPException:
        raise
    except jwt.ExpiredSignatureError as e:
        logger.warning("JWT validation failed: session expired")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Session expired: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except Exception as e:
        logger.warning("JWT validation failed: %s", type(e).__name__)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed. Please sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )

def _provision_profile_idempotent(db: Session, user_id: uuid.UUID, payload: dict) -> Profile:
    """
    Idempotently provisions or retrieves a user profile for a verified Supabase JWT.
    Uses thread-safe locking and email fallback matching to prevent race conditions.
    """
    profile = db.query(Profile).filter(Profile.id == user_id).first()
    if profile:
        return profile

    with _migration_lock:
        # Re-check inside lock
        profile = db.query(Profile).filter(Profile.id == user_id).first()
        if profile:
            return profile

        email = payload.get("email", "")
        user_metadata = payload.get("user_metadata", {})
        full_name = user_metadata.get("full_name") or payload.get("full_name") or ""
        if not full_name and email:
            full_name = email.split("@")[0].capitalize()
        if not full_name:
            full_name = "User"

        # Handle existing profile with same email (e.g. legacy/orphaned ID)
        if email:
            existing_by_email = db.query(Profile).filter(Profile.email == email).first()
            if existing_by_email:
                if existing_by_email.id == user_id:
                    return existing_by_email
                logger.critical(
                    f"[SECURITY AUDIT] Auto-triggering purge_orphaned_profile: "
                    f"email={email} | old_profile_id={existing_by_email.id} | new_auth_id={user_id}. "
                    "This replaces an orphaned profile on re-registration. Review if unexpected."
                )
                try:
                    from app.services.account_service import AccountService
                    AccountService.purge_orphaned_profile(db, email)
                except Exception as e:
                    logger.error(f"Failed to purge orphaned profile for email {email}: {e}", exc_info=e)
                    db.rollback()

        try:
            profile = Profile(
                id=user_id,
                email=email if email else f"user_{user_id.hex[:8]}@example.com",
                full_name=full_name,
                hashed_password="supabase-authenticated",
                is_active=True
            )
            db.add(profile)
            db.commit()
            db.refresh(profile)
            logger.info(f"Auto-provisioned self-healing profile for user_id={user_id} email={profile.email}")
            return profile
        except Exception as e:
            db.rollback()
            # Double check if created concurrently
            profile = db.query(Profile).filter(Profile.id == user_id).first()
            if profile:
                return profile
            logger.error(f"Failed to auto-provision profile for user_id={user_id}: {e}", exc_info=e)
            raise HTTPException(status_code=500, detail="Failed to initialize user profile.")


def get_current_user(
    request: Request = None,
    payload: dict = Depends(verify_supabase_token),
    db: Session = Depends(get_db)
) -> Profile:
    user_id_str = payload.get("sub")
    if not user_id_str:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    if user_id_str in ["mock-token", "00000000-0000-0000-0000-000000000000"]:
        try:
            profile = db.query(Profile).first()
            if profile:
                return profile
        except Exception:
            pass
        return Profile(
            id=uuid.UUID("00000000-0000-0000-0000-000000000000"),
            email="ceo@example.com",
            full_name="CEO EVE"
        )

    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid user ID format")
        
    path = request.url.path if request else ""
    if path.endswith("/api/profile/me"):
        logger.info("DB query start")
    profile = db.query(Profile).filter(Profile.id == user_id).first()
    if path.endswith("/api/profile/me"):
        logger.info("DB query finish")
        
    if not profile:
        # Self-healing: auto-provision profile idempotently for valid JWTs
        profile = _provision_profile_idempotent(db, user_id, payload)
            
    return profile


from fastapi import Header
from typing import Optional
from app.models.organization import Membership

def get_active_workspace_id(
    x_workspace_id: Optional[str] = Header(None),
    current_user: Profile = Depends(get_current_user),
    db: Session = Depends(get_db)
) -> Optional[uuid.UUID]:
    """
    Extracts and validates the active workspace from the X-Workspace-Id header.
    If header is specified, user MUST be a member of that workspace (raises 403 otherwise).
    If header is missing, falls back to the user's primary membership.
    """
    if x_workspace_id:
        try:
            workspace_uuid = uuid.UUID(x_workspace_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid X-Workspace-Id format"
            )

        membership = db.query(Membership).filter(
            Membership.user_id == current_user.id,
            Membership.organization_id == workspace_uuid
        ).first()

        if not membership:
            logger.warning(f"[EVE Security] User {current_user.id} denied access to non-member workspace {x_workspace_id}.")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not a member of this workspace"
            )
        return workspace_uuid

    # Primary membership fallback when no header is supplied
    membership = db.query(Membership).filter(Membership.user_id == current_user.id).first()
    return membership.organization_id if membership else None



def get_required_workspace_id(
    workspace_id: Optional[uuid.UUID] = Depends(get_active_workspace_id)
) -> uuid.UUID:
    """
    Validates that a workspace is active and returns its ID. Raises 400 if missing.
    """
    if not workspace_id:
        raise HTTPException(status_code=400, detail="Active workspace is required for this operation")
    return workspace_id


def verify_workspace_admin(
    current_user: Profile = Depends(get_current_user),
    workspace_id: uuid.UUID = Depends(get_required_workspace_id),
    db: Session = Depends(get_db)
) -> Membership:
    """
    Verifies that the current user has admin/owner privileges in the active workspace.
    """
    membership = db.query(Membership).filter(
        Membership.user_id == current_user.id,
        Membership.organization_id == workspace_id
    ).first()
    
    if not membership or membership.role not in ["admin", "owner"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required for this workspace"
        )
    return membership


def get_current_user_and_tenant(
    workspace_id: uuid.UUID = Depends(get_required_workspace_id),
    current_user: Profile = Depends(get_current_user)
):
    """
    Backwards compatible dependency returning standard tenant context.
    """
    return {"user_id": current_user.id, "organization_id": workspace_id}


def require_workspace_role(minimum_role: str):
    def dependency(
        current_user: Profile = Depends(get_current_user),
        workspace_id: uuid.UUID = Depends(get_required_workspace_id),
        db: Session = Depends(get_db)
    ) -> Membership:
        # Standardize role hierarchy: employee < manager/member < admin < owner
        min_role_normalized = minimum_role.lower()
        if min_role_normalized == "employee":
            min_rank = 1
        elif min_role_normalized in ["manager", "member"]:
            min_rank = 2
        elif min_role_normalized == "admin":
            min_rank = 3
        elif min_role_normalized == "owner":
            min_rank = 4
        else:
            min_rank = 1

        membership = db.query(Membership).filter(
            Membership.user_id == current_user.id,
            Membership.organization_id == workspace_id
        ).first()

        if not membership:
            raise HTTPException(status_code=403, detail="Not a member of this workspace")

        user_role = membership.role.lower()
        if user_role == "employee":
            user_rank = 1
        elif user_role in ["manager", "member"]:
            user_rank = 2
        elif user_role == "admin":
            user_rank = 3
        elif user_role == "owner":
            user_rank = 4
        else:
            user_rank = 1

        if user_rank < min_rank:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient workspace permissions"
            )
        return membership
    return dependency


def verify_system_admin(
    current_user: Profile = Depends(get_current_user)
) -> Profile:
    """
    Verifies that the current user has global platform administrator status.
    """
    if current_user.subscription_status != "founder":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="System Administrator privileges required for this operation"
        )
    return current_user


