# ==============================================================================
# PURPOSE: Inventory and CSV Data Upload API Routes.
# DATA FLOW: Takes CSV files -> parses using Pandas with flexible column mapping ->
#            upserts into Product, InventoryItem, and SalesRecord database tables.
# EXTENSION POINTS: Add CSV schema schema validation, support asynchronous queues.
# ARCHITECTURAL DECISION:
# - Relaxed column validations allow various spreadsheet templates to load seamlessly.
# - Leverages database fallback queries to resolve missing metrics (e.g. using
#   product selling_price to calculate sales revenue if missing in the CSV).
# ==============================================================================

import io
import datetime
import logging
# NOTE: pandas is imported lazily inside the upload handlers (not at module level)
# to avoid adding ~770ms to cold start time.
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, status, BackgroundTasks
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models.product import Product
from app.models.inventory import InventoryItem, SalesRecord
from app.core.security import get_current_user_and_tenant, require_workspace_role
# Both pandas and ImporterService are imported lazily (on first CSV upload request)
# because importer_service.py eagerly imports pandas, which adds ~770ms to cold start time.
_importer_service_module = None
_pandas_module = None


def _get_importer():
    global _importer_service_module
    if _importer_service_module is None:
        from app.services.importer_service import ImporterService as _IS
        _importer_service_module = _IS
    return _importer_service_module


def _pd():
    """Lazy pandas accessor — import deferred to first CSV upload request."""
    global _pandas_module
    if _pandas_module is None:
        import pandas as _pandas
        _pandas_module = _pandas
    return _pandas_module


from app.core.rate_limiter import rate_limit
from app.fashion.gmroi import calculate_gmroi
from app.fashion.sell_through import calculate_sell_through_rate
from app.fashion.inventory_turnover import calculate_inventory_turnover
from app.services.ai.proactive_analysis_service import ProactiveAnalysisService

logger = logging.getLogger("eve.routes.inventory")
router = APIRouter(prefix="/api/inventory", tags=["inventory"])

MAX_CSV_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB hard limit for uploaded CSV files



@router.post("/upload/inventory", status_code=status.HTTP_201_CREATED)
def upload_inventory_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    token_context: dict = Depends(get_current_user_and_tenant),
    _: None = Depends(rate_limit(requests=10, window_seconds=60)),
    _role = Depends(require_workspace_role("manager")),
    background_tasks: BackgroundTasks = None
):
    """
    Uploads and parses inventory.csv.
    """
    org_id = token_context["organization_id"]
    logger.info(f"Inventory Upload: Received file '{file.filename}' from tenant Org: {org_id}")

    try:
        contents = file.file.read()
        if not contents or len(contents) == 0:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"status": "error", "message": "Uploaded file is empty."}
            )
        if len(contents) > MAX_CSV_SIZE_BYTES:
            return JSONResponse(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                content={"status": "error", "message": "File size exceeds 10MB limit. Please split your CSV into smaller batches."}
            )
        
        try:
            df = _pd().read_csv(io.BytesIO(contents))
        except (_pd().errors.EmptyDataError, _pd().errors.ParserError) as pe:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"status": "error", "message": f"Failed to parse CSV file: {str(pe)}"}
            )

        report = _get_importer().import_inventory(db, org_id, df)
        if report["status"] == "error":
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=report)
        if background_tasks:
            background_tasks.add_task(ProactiveAnalysisService.generate_baseline_recommendations_async, org_id, token_context.get("user_id"))
        return JSONResponse(status_code=status.HTTP_201_CREATED, content=report)
    except Exception as e:
        logger.error(f"Inventory Upload Error: {e}", exc_info=e)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"status": "error", "message": f"Failed to process inventory CSV: {str(e)}"}
        )


@router.post("/upload/sales", status_code=status.HTTP_201_CREATED)
def upload_sales_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    token_context: dict = Depends(get_current_user_and_tenant),
    _: None = Depends(rate_limit(requests=10, window_seconds=60)),
    _role = Depends(require_workspace_role("manager")),
    background_tasks: BackgroundTasks = None
):
    """
    Uploads and parses sales.csv.
    """
    org_id = token_context["organization_id"]
    logger.info(f"Sales Upload: Received file '{file.filename}' from tenant Org: {org_id}")

    try:
        contents = file.file.read()
        if not contents or len(contents) == 0:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"status": "error", "message": "Uploaded file is empty."}
            )
        if len(contents) > MAX_CSV_SIZE_BYTES:
            return JSONResponse(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                content={"status": "error", "message": "File size exceeds 10MB limit. Please split your CSV into smaller batches."}
            )

        try:
            df = _pd().read_csv(io.BytesIO(contents))
        except (_pd().errors.EmptyDataError, _pd().errors.ParserError) as pe:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"status": "error", "message": f"Failed to parse CSV file: {str(pe)}"}
            )

        report = _get_importer().import_sales(db, org_id, df)
        if report["status"] == "error":
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=report)
        if background_tasks:
            background_tasks.add_task(ProactiveAnalysisService.generate_baseline_recommendations_async, org_id, token_context.get("user_id"))
        return JSONResponse(status_code=status.HTTP_201_CREATED, content=report)
    except Exception as e:
        logger.error(f"Sales Upload Error: {e}", exc_info=e)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"status": "error", "message": f"Failed to process sales CSV: {str(e)}"}
        )


@router.post("/upload/costs", status_code=status.HTTP_201_CREATED)
def upload_product_costs_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    token_context: dict = Depends(get_current_user_and_tenant),
    _: None = Depends(rate_limit(requests=10, window_seconds=60)),
    _role = Depends(require_workspace_role("manager")),
    background_tasks: BackgroundTasks = None
):
    """
    Uploads and parses product_cost.csv / costs.csv.
    """
    org_id = token_context["organization_id"]
    logger.info(f"Costs Upload: Received file '{file.filename}' from tenant Org: {org_id}")

    try:
        contents = file.file.read()
        if not contents or len(contents) == 0:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"status": "error", "message": "Uploaded file is empty."}
            )
        if len(contents) > MAX_CSV_SIZE_BYTES:
            return JSONResponse(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                content={"status": "error", "message": "File size exceeds 10MB limit. Please split your CSV into smaller batches."}
            )

        try:
            df = _pd().read_csv(io.BytesIO(contents))
        except (_pd().errors.EmptyDataError, _pd().errors.ParserError) as pe:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"status": "error", "message": f"Failed to parse CSV file: {str(pe)}"}
            )

        report = _get_importer().import_costs(db, org_id, df)
        if report["status"] == "error":
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=report)
        if background_tasks:
            background_tasks.add_task(ProactiveAnalysisService.generate_baseline_recommendations_async, org_id, token_context.get("user_id"))
        return JSONResponse(status_code=status.HTTP_201_CREATED, content=report)
    except Exception as e:
        logger.error(f"Costs Upload Error: {e}", exc_info=e)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"status": "error", "message": f"Failed to process product cost CSV: {str(e)}"}
        )

@router.post("/upload/master", status_code=status.HTTP_201_CREATED)
def upload_master_csv(
    file: UploadFile = File(...),
    mode: str = "merge",
    db: Session = Depends(get_db),
    token_context: dict = Depends(get_current_user_and_tenant),
    _: None = Depends(rate_limit(requests=10, window_seconds=60)),
    _role = Depends(require_workspace_role("manager")),
    background_tasks: BackgroundTasks = None
):
    """
    Uploads and parses a master CSV (e.g. Shopify export).

    mode="merge" (default) upserts by SKU into whatever the workspace already
    holds — the historical behaviour, correct for a workspace that is already
    the merchant's own.

    mode="replace" clears the workspace first. It exists for exactly one case:
    a merchant importing their real catalogue into a workspace still holding
    seeded demo data. Merging those two produces an inventory valuation that is
    part real and part fiction, which is worse than either alone. Guarded to
    demo workspaces only — see below.
    """
    org_id = token_context["organization_id"]
    logger.info(f"Master Upload: Received file '{file.filename}' from tenant Org: {org_id} (mode={mode})")

    if mode not in ("merge", "replace"):
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"status": "error", "message": "mode must be 'merge' or 'replace'."}
        )

    try:
        contents = file.file.read()
        if not contents or len(contents) == 0:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"status": "error", "message": "Uploaded file is empty."}
            )
        if len(contents) > MAX_CSV_SIZE_BYTES:
            return JSONResponse(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                content={"status": "error", "message": "File size exceeds 10MB limit. Please split your CSV into smaller batches."}
            )

        try:
            df = _pd().read_csv(io.BytesIO(contents))
        except (_pd().errors.EmptyDataError, _pd().errors.ParserError) as pe:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"status": "error", "message": f"Failed to parse CSV file: {str(pe)}"}
            )

        if mode == "replace":
            from app.models.organization import Organization
            from app.commands.seed_scenarios import clean_org_data

            org = db.query(Organization).filter(Organization.id == org_id).first()
            if org is None:
                raise HTTPException(status_code=404, detail="Workspace not found")

            # HARD GUARD: replace is destructive, so it is permitted ONLY on a
            # workspace we provisioned as a demo. A merchant's own workspace can
            # never be wiped through this path, whatever the client sends.
            if org.scenario_type is None:
                return JSONResponse(
                    status_code=status.HTTP_409_CONFLICT,
                    content={
                        "status": "error",
                        "message": "This workspace already holds your own data. Import without replace, or delete the workspace explicitly.",
                    },
                )

            # Validate BEFORE deleting anything. A malformed CSV must never be
            # able to empty a workspace — the merchant would lose the demo they
            # were still evaluating and get nothing in return.
            precheck = _get_importer().normalize_shopify_export(df.copy())
            is_valid, missing = _get_importer().validate_schema(precheck, ["sku"])
            if not is_valid:
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={
                        "status": "error", "total_rows": len(df), "valid_rows": 0,
                        "invalid_rows": len(df), "duplicate_rows": 0,
                        "missing_columns": missing,
                        "errors": [{
                            "row": 0, "column": "headers", "value": None,
                            "message": f"Missing required columns: {missing}",
                        }],
                    },
                )

            # Same org-scoped cleanup the seeder runs before provisioning a demo.
            clean_org_data(db, org_id)

            # The workspace now holds the merchant's data, not ours. Clearing
            # scenario_type retires the demo badge, stops the import guard from
            # firing again, and makes is_demo report the truth.
            org.scenario_type = None
            db.add(org)
            db.commit()
            logger.info(f"Master Upload: replaced demo data for Org {org_id}; workspace is now merchant-owned")

        report = _get_importer().import_master(db, org_id, df)
        if report["status"] == "error":
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=report)
        if background_tasks:
            background_tasks.add_task(ProactiveAnalysisService.generate_baseline_recommendations_async, org_id, token_context.get("user_id"))
        return JSONResponse(status_code=status.HTTP_201_CREATED, content=report)
    except Exception as e:
        logger.error(f"Master Upload Error: {e}", exc_info=e)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"status": "error", "message": f"Failed to process master CSV: {str(e)}"}
        )

@router.post("/upload/preview")
def preview_upload_csv(
    file: UploadFile = File(...),
    token_context: dict = Depends(get_current_user_and_tenant),
    _role = Depends(require_workspace_role("manager"))
):
    """
    Parses a CSV to detect apparel variants, returning the grouping preview
    without committing anything to the database.
    """
    try:
        from app.fashion.variant_detector import detect_variants
    except ImportError:
        return JSONResponse(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            content={"status": "error", "message": "Variant detection module not available."}
        )

    try:
        contents = file.file.read()
        if not contents or len(contents) == 0:
            return JSONResponse(status_code=400, content={"status": "error", "message": "File is empty."})
        
        df = _pd().read_csv(io.BytesIO(contents))
        df.columns = [c.strip().lower() for c in df.columns]
        
        if "sku" not in df.columns or "name" not in df.columns:
            return JSONResponse(status_code=400, content={"status": "error", "message": "CSV must contain 'sku' and 'name' columns."})
            
        product_list = []
        for _, r in df.iterrows():
            sku_val = str(r.get("sku", "")).strip()
            name_val = str(r.get("name", "")).strip()
            if sku_val and sku_val != "nan":
                product_list.append({"sku": sku_val, "name": name_val})
                
        detection = detect_variants(product_list)
        
        # Serialize result
        result = {
            "detected_variants": [
                {
                    "parent_name": group.parent_name,
                    "parent_id": group.parent_product_id,
                    "variants": [
                        {
                            "sku": v.sku,
                            "name": v.original_name,
                            "color": v.color,
                            "size": v.size
                        } for v in group.variants
                    ],
                    "detected_sizes": group.detected_sizes,
                    "detected_colors": group.detected_colors
                } for group in detection.variant_groups
            ],
            "unmatched_products": detection.unmatched_products,
            "total_products": detection.total_products,
            "total_variants_detected": detection.total_variants_detected,
            "detection_confidence": detection.detection_confidence
        }
        
        return JSONResponse(status_code=200, content=result)
        
    except Exception as e:
        logger.error(f"Preview Upload Error: {e}", exc_info=e)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"status": "error", "message": f"Failed to parse CSV preview: {str(e)}"}
        )


@router.get("/dashboard")
def get_inventory_dashboard(
    db: Session = Depends(get_db),
    token_context: dict = Depends(get_current_user_and_tenant)
):
    """
    Returns aggregated metrics and product performance for the inventory dashboard.
    """
    from sqlalchemy import func
    org_id = token_context["organization_id"]
    
    try:
        # Fetch inventory items and products
        items = db.query(InventoryItem).options(joinedload(InventoryItem.product)).filter(InventoryItem.organization_id == org_id).all()
        
        # Calculate total value and stock counts
        total_value = sum(item.stock_on_hand * (item.product.unit_cost or 0.0) for item in items)
        total_items_count = sum(item.stock_on_hand for item in items)
        low_stock_count = sum(1 for item in items if item.stock_on_hand <= item.reorder_point)
        
        # Fetch sales aggregated by product
        sales_data = db.query(
            SalesRecord.product_id,
            func.sum(SalesRecord.quantity).label("total_qty"),
            func.sum(SalesRecord.revenue).label("total_rev")
        ).filter(SalesRecord.organization_id == org_id)\
         .group_by(SalesRecord.product_id).all()
         
        sales_map = {row[0]: {"qty": int(row[1]), "rev": float(row[2])} for row in sales_data}
        
        product_metrics = []
        for item in items:
            prod = item.product
            sales = sales_map.get(prod.id, {"qty": 0, "rev": 0.0})
            qty_sold = sales["qty"]
            revenue = sales["rev"]
            cogs = qty_sold * (prod.unit_cost or 0.0)
            profit = revenue - cogs
            margin = (profit / revenue * 100.0) if revenue > 0 else 0.0
            
            # Compute advanced fashion retail metrics
            avg_stock_value = item.stock_on_hand * (prod.unit_cost or 0.0)
            gmroi_val = calculate_gmroi(profit, avg_stock_value)
            sell_through_val = calculate_sell_through_rate(qty_sold, item.stock_on_hand)
            turnover_val = calculate_inventory_turnover(cogs, avg_stock_value)
            
            product_metrics.append({
                "sku": prod.sku,
                "name": prod.name,
                "category": prod.category,
                "stock_on_hand": item.stock_on_hand,
                "unit_cost": prod.unit_cost or 0.0,
                "qty_sold": qty_sold,
                "revenue": round(revenue, 2),
                "profit": round(profit, 2),
                "margin_percent": round(margin, 2),
                "gmroi": gmroi_val,
                "sell_through_rate": sell_through_val,
                "inventory_turnover": turnover_val
            })
            
        # Extract best and worst sellers
        best_sellers = sorted(product_metrics, key=lambda x: x["qty_sold"], reverse=True)[:5]
        worst_sellers = sorted(product_metrics, key=lambda x: x["qty_sold"])[:5]
        
        return {
            "total_inventory_value": round(total_value, 2),
            "total_items_count": total_items_count,
            "low_stock_count": low_stock_count,
            "best_sellers": best_sellers,
            "worst_sellers": worst_sellers,
            "product_metrics": product_metrics
        }
    except Exception as e:
        logger.error(f"Inventory Dashboard Error: {e}", exc_info=e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to load inventory dashboard data: {str(e)}"
        )


# ---------------------------------------------------------------------------
# Pydantic request schemas (defined inline — no separate schema file needed)
# ---------------------------------------------------------------------------

class ProductCreateRequest(BaseModel):
    """Request body for manually creating a product and its initial inventory record."""
    sku: str
    name: str
    category: str
    stock_on_hand: int = Field(default=0, ge=0)
    unit_cost: float = Field(default=0.0, ge=0)
    selling_price: float = Field(default=0.0, ge=0)
    reorder_point: int = Field(default=10, ge=0)
    supplier_name: Optional[str] = None


class StockUpdateRequest(BaseModel):
    """Request body for updating a product's stock level."""
    stock_on_hand: int = Field(ge=0)
    reorder_point: Optional[int] = Field(default=None, ge=0)


# ---------------------------------------------------------------------------
# New CRUD / alert endpoints
# ---------------------------------------------------------------------------

@router.post("/product", status_code=status.HTTP_201_CREATED)
def create_product(
    body: ProductCreateRequest,
    db: Session = Depends(get_db),
    token_context: dict = Depends(get_current_user_and_tenant),
    _role = Depends(require_workspace_role("manager"))
):
    """
    Manually create a product and its initial inventory record.
    Validates SKU uniqueness within the workspace before inserting.
    """
    from app.models.inventory import InventoryItem
    org_id = token_context["organization_id"]

    # Prevent duplicate SKUs within the same organization
    existing = db.query(Product).filter(
        Product.organization_id == org_id,
        Product.sku == body.sku
    ).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"SKU '{body.sku}' already exists in this workspace."
        )

    product = Product(
        organization_id=org_id,
        sku=body.sku,
        name=body.name,
        category=body.category,
        unit_cost=body.unit_cost,
        selling_price=body.selling_price,
        supplier_name=body.supplier_name,
    )
    db.add(product)
    db.flush()  # Populate product.id before creating the linked inventory item

    inventory_item = InventoryItem(
        organization_id=org_id,
        product_id=product.id,
        stock_on_hand=body.stock_on_hand,
        reorder_point=body.reorder_point,
    )
    db.add(inventory_item)
    db.commit()
    db.refresh(product)

    return {
        "status": "success",
        "message": f"Product '{body.name}' created.",
        "product_id": str(product.id)
    }


@router.put("/product/{sku}/stock")
def update_product_stock(
    sku: str,
    body: StockUpdateRequest,
    db: Session = Depends(get_db),
    token_context: dict = Depends(get_current_user_and_tenant),
    _role = Depends(require_workspace_role("manager"))
):
    """
    Update stock level (and optionally reorder_point) for a specific SKU.
    """
    from app.models.inventory import InventoryItem
    org_id = token_context["organization_id"]

    product = db.query(Product).filter(
        Product.organization_id == org_id,
        Product.sku == sku
    ).first()
    if not product:
        raise HTTPException(status_code=404, detail=f"SKU '{sku}' not found.")

    item = db.query(InventoryItem).filter(
        InventoryItem.organization_id == org_id,
        InventoryItem.product_id == product.id
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory record not found.")

    item.stock_on_hand = body.stock_on_hand
    if body.reorder_point is not None:
        item.reorder_point = body.reorder_point
    db.commit()

    return {"status": "success", "sku": sku, "new_stock": body.stock_on_hand}


@router.get("/alerts")
def get_inventory_alerts(
    db: Session = Depends(get_db),
    token_context: dict = Depends(get_current_user_and_tenant)
):
    """
    Returns two alert categories for the workspace:
    - low_stock: items at or below their reorder_point, enriched with days-of-supply and revenue at risk
    - dead_stock: items with stock > 0 but no sales in the last 30 days, enriched with capital locked
    """
    from sqlalchemy.orm import joinedload
    from sqlalchemy import func as sqlfunc
    from app.models.inventory import InventoryItem, SalesRecord
    from app.models.recommendation_trace import RecommendationTrace

    org_id = token_context["organization_id"]
    thirty_days_ago = datetime.date.today() - datetime.timedelta(days=30)

    # Load all inventory items with their associated products
    items = (
        db.query(InventoryItem)
        .options(joinedload(InventoryItem.product))
        .filter(InventoryItem.organization_id == org_id)
        .all()
    )

    # Bulk-fetch 30-day sales velocity per product for days-of-supply calculation
    thirty_day_sales = db.query(
        SalesRecord.product_id,
        sqlfunc.sum(SalesRecord.quantity).label("qty_30d")
    ).filter(
        SalesRecord.organization_id == org_id,
        SalesRecord.date >= thirty_days_ago,
        SalesRecord.quantity > 0
    ).group_by(SalesRecord.product_id).all()

    qty_30d_map = {row[0]: int(row[1]) for row in thirty_day_sales if row[1] is not None}

    # Collect product IDs that have had at least one sale in the last 30 days
    recent_ids = set(qty_30d_map.keys())

    # Pull revenue-at-risk from seeded recommendation traces keyed by SKU
    trace_rows = db.query(
        RecommendationTrace
    ).filter(
        RecommendationTrace.organization_id == org_id,
        RecommendationTrace.recommendation_type.in_(["low_stock", "dead_stock", "reorder", "markdown", "optimization"])
    ).all()

    trace_by_sku: dict = {}
    for t in trace_rows:
        for sku in (t.related_skus or []):
            trace_by_sku[sku] = t

    low_stock = []
    dead_stock = []

    for item in items:
        prod = item.product
        qty_30d = qty_30d_map.get(prod.id, 0)
        avg_daily = round(qty_30d / 30.0, 2) if qty_30d > 0 else 0.0
        days_of_supply = round(item.stock_on_hand / avg_daily, 1) if avg_daily > 0 else None

        if item.stock_on_hand <= item.reorder_point:
            trace = trace_by_sku.get(prod.sku)
            revenue_at_risk = None
            if trace and trace.estimated_financial_impact:
                revenue_at_risk = round(float(trace.estimated_financial_impact), 2)
            elif avg_daily > 0 and item.lead_time_days:
                # Stockout gap = lead_time - days_of_supply (clamped to 0)
                gap_days = max(0.0, item.lead_time_days - (days_of_supply or 0.0))
                revenue_at_risk = round(gap_days * avg_daily * (prod.selling_price or 0.0), 2)

            low_stock.append({
                "sku": prod.sku,
                "name": prod.name,
                "category": prod.category,
                "stock_on_hand": item.stock_on_hand,
                "reorder_point": item.reorder_point,
                "shortage": max(0, item.reorder_point - item.stock_on_hand),
                "avg_daily_sales": avg_daily,
                "days_of_supply": days_of_supply,
                "lead_time_days": item.lead_time_days,
                "revenue_at_risk": revenue_at_risk,
                "unit_cost": prod.unit_cost or 0.0,
                "supplier_name": prod.supplier_name,
                "recommended_order_qty": (
                    round(avg_daily * (item.lead_time_days + 5))
                    if avg_daily > 0 and item.lead_time_days
                    else max(0, item.reorder_point - item.stock_on_hand)
                ),
            })

        if item.stock_on_hand > 0 and prod.id not in recent_ids:
            capital_locked = round(item.stock_on_hand * (prod.unit_cost or 0.0), 2)
            monthly_carrying_cost = round(capital_locked * 0.03, 2)
            trace = trace_by_sku.get(prod.sku)
            days_since_last_sale = None
            if trace and trace.supporting_metrics:
                raw = trace.supporting_metrics.get("inventory_age") or trace.supporting_metrics.get("days_since_last_sale")
                if raw:
                    import re as _re
                    m = _re.search(r"\d+", str(raw))
                    if m:
                        days_since_last_sale = int(m.group(0))

            dead_stock.append({
                "sku": prod.sku,
                "name": prod.name,
                "category": prod.category,
                "stock_on_hand": item.stock_on_hand,
                "estimated_value": capital_locked,
                "monthly_carrying_cost": monthly_carrying_cost,
                "days_since_last_sale": days_since_last_sale,
            })

    total_revenue_at_risk = round(sum(
        item["revenue_at_risk"] for item in low_stock if item["revenue_at_risk"] is not None
    ), 2)
    total_capital_locked = round(sum(item["estimated_value"] for item in dead_stock), 2)
    total_recommended_order_units = sum(item["recommended_order_qty"] for item in low_stock)

    return {
        "low_stock": sorted(low_stock, key=lambda x: (x["revenue_at_risk"] or 0), reverse=True),
        "dead_stock": sorted(dead_stock, key=lambda x: x["estimated_value"], reverse=True),
        "low_stock_count": len(low_stock),
        "dead_stock_count": len(dead_stock),
        "total_revenue_at_risk": total_revenue_at_risk,
        "total_capital_locked": total_capital_locked,
        "total_recommended_order_units": total_recommended_order_units,
    }



