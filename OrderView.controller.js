sap.ui.define([
    "sap/ui/model/json/JSONModel",
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/base/Log",
    "sap/m/MessageToast"
], function (JSONModel, PluginViewController, Log, MessageToast) {
    "use strict";

    // =======================
    // === Helper Functions ===
    // =======================

    /**
     * Extract the UOM (Unit of Measure) for an order from the backend object.
     * Tries in order: production UOM, ERP UOM, base UOM. Returns "" if not found.
     * @param {object} orderApiObj - The raw order object from API.
     * @returns {string} - Unit of Measure or "".
     */
    function getOrderUOM(orderApiObj) {
        // Prefer the most specific UOM if available
        if (orderApiObj.productionUnitOfMeasureObject && orderApiObj.productionUnitOfMeasureObject.uom) {
            return orderApiObj.productionUnitOfMeasureObject.uom;
        }
        if (orderApiObj.erpUnitOfMeasure) {
            return orderApiObj.erpUnitOfMeasure;
        }
        if (orderApiObj.baseUnitOfMeasureObject && orderApiObj.baseUnitOfMeasureObject.uom) {
            return orderApiObj.baseUnitOfMeasureObject.uom;
        }
        return "";
    }

    /**
     * Formats an ISO date string to "DD/MM/YYYY, hh:mm:ss am/pm" (Indian locale).
     * Returns "-" if input is invalid.
     * @param {string} dateStr - ISO date string.
     * @returns {string}
     */
    function formatDate(dateStr) {
        if (!dateStr) return "-";
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return "-";
            // Format: 'Jul 31, 2025, 6:00:30 PM'
            return date.toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
        } catch {
            return "-";
        }
    }
    

    /**
     * Parse and validate a SAPUI5 DatePicker value to a Date object.
     * Returns null if the value is empty or not a valid date.
     * @param {sap.m.DatePicker} oDatePicker - The DatePicker instance.
     * @returns {Date|null}
     */
    function parseDatePickerValue(oDatePicker) {
        if (!oDatePicker) return null;
        const value = oDatePicker.getValue();
        if (!value) return null;
        // Handles both ISO and formatted values (browser dependent)
        const dt = new Date(value);
        return isNaN(dt.getTime()) ? null : dt;
    }

    /**
     * Maps a raw API order object to a UI table row object for model binding.
     * Handles missing fields, formatting, and aggregates UI-friendly values.
     * @param {object} orderApiObj - Raw order object from API.
     * @returns {object} - Row object for table/model.
     */
    function mapOrderApiToUiRow(orderApiObj) {
        const uom = getOrderUOM(orderApiObj);
        return {
            orderNo: orderApiObj.order || "-",
            parentSFC: "-", // Default, will be filled later asynchronously if needed
            materialLine: orderApiObj.material
                ? (orderApiObj.material.material + " / " + (orderApiObj.material.version || ""))
                : "-",
            materialDesc: orderApiObj.material?.description || "",
            executionStatus: orderApiObj.executionStatus || "-",
            buildQty: orderApiObj.buildQuantity !== undefined ? orderApiObj.buildQuantity + " " + uom : "-",
            doneQty: orderApiObj.doneQuantity !== undefined ? orderApiObj.doneQuantity + " " + uom : "-",
            // dmReleasedQty: orderApiObj.dmReleasedQty !== undefined ? orderApiObj.dmReleasedQty + " " + uom : "-",
            availableQty:
                (orderApiObj.buildQuantity !== undefined && orderApiObj.doneQuantity !== undefined)
                    ? (orderApiObj.buildQuantity - orderApiObj.doneQuantity) + " " + uom
                    : "-",
            scheduledStartEnd: formatDate(orderApiObj.scheduledStartDate) + "\n" + formatDate(orderApiObj.scheduledCompletionDate),
            scheduledStartDate: orderApiObj.scheduledStartDate,
            scheduledCompletionDate: orderApiObj.scheduledCompletionDate,
            priority: orderApiObj.priority || "-",

            enabled: orderApiObj.executionStatus === "ACTIVE"
        };
    }
    

    // ===========================================================
    // === Controller definition for Order View (main class) ===
    // ===========================================================

    return PluginViewController.extend("bobm.custom.completeorderplugin.orderviewplugin.controller.OrderView", {
        metadata: { properties: {} },

        /**
         * Called on controller initialization. Sets up empty order model for UI table.
         */
        onInit: function () {
            // Call super (base class) init if present (important for plugin lifecycle)
            if (PluginViewController.prototype.onInit) {
                PluginViewController.prototype.onInit.apply(this, arguments);
            }
            // Initialize an empty model so the UI can bind to it without errors
            this.getView().setModel(new JSONModel({ orders: [], selectedOrderNo: "" }), "orderModel");
        },

        /**
         * Handler for "Filter" button press.
         * Reads all input fields, validates mandatory fields,
         * builds API request, fetches and processes results, and binds to table.
         * Shows MessageToast for any input errors or backend failures.
         */
        onFilterPress: function () {
            // Gather input controls by their IDs
            const oMaterial = this.byId("materialInput");
            const oExecutionStatus = this.byId("executionStatusSelect");
            const oOrderNo = this.byId("orderNoInput");
            const oDateFrom = this.byId("dateFromInput");
            const oDateTo = this.byId("dateToInput");
            const oItemsHeading = this.byId("itemsHeading"); // For item count display
        
            // Extract/normalize values
            const material = oMaterial ? oMaterial.getValue().trim() : "";
            const executionStatus = oExecutionStatus ? oExecutionStatus.getSelectedKey() : "";
            const orderNumber = oOrderNo ? oOrderNo.getValue().trim() : "";
            const dateFromObj = parseDatePickerValue(oDateFrom);
            const dateToObj = parseDatePickerValue(oDateTo);

            // === Validation section ===

            // Material is mandatory (per business logic)
            if (!material) {
                MessageToast.show("Material is mandatory.");
                return;
            }
            // From date cannot be after To date
            if (dateFromObj && dateToObj && dateFromObj > dateToObj) {
                MessageToast.show("Date From cannot be later than Date To.");
                return;
            }

            // === Prepare API parameters ===

            // Convert dates to API-friendly format (YYYY-MM-DD)
            const dateFromStr = dateFromObj ? dateFromObj.toISOString().substring(0, 10) : null;
            const dateToStr = dateToObj ? dateToObj.toISOString().substring(0, 10) : null;

            // Fetch plant from pod controller, which may depend on logged-in user/session
            const oPlant = this.getPodController().getUserPlant();

            // Backend API endpoint for order list
            const sListUrl = this.getPublicApiRestDataSourceUri() + "/order/v1/orders/list";

            // Query parameters for API call
            const params = { plant: oPlant, material: material, size: 200, page: 0 };
            if (executionStatus) params.executionStatus = executionStatus;
            if (orderNumber) params.orderNumber = orderNumber;
            if (dateFromStr) params.dateFrom = dateFromStr;
            if (dateToStr) params.dateTo = dateToStr;

            // === Actual backend fetch ===

            fetch(sListUrl + "?" + new URLSearchParams(params).toString())
            .then(response => {
                if (!response.ok) throw new Error("Server/API error");
                return response.json();
            })
            .then(async apiData => {
                let ordersList = apiData.content || [];

                // === Client-side post-filtering (for extra safety) ===

                // Filter by date range if both are provided (redundant if backend already filters)
                if (dateFromObj && dateToObj) {
                    ordersList = ordersList.filter(item => {
                        if (!item.scheduledStartDate || !item.scheduledCompletionDate) return false;
                        const itemStart = new Date(item.scheduledStartDate);
                        const itemEnd = new Date(item.scheduledCompletionDate);
                        // Only include orders fully within range
                        return (itemStart >= dateFromObj && itemEnd <= dateToObj);
                    });
                }

                // Filter by execution status, if specified (extra check, as backend should already filter)
                if (executionStatus) {
                    ordersList = ordersList.filter(item =>
                        item.executionStatus && item.executionStatus === executionStatus
                    );
                }

                // Client-side filter for order number (in case backend search is partial or exact)
                if (orderNumber) {
                    ordersList = ordersList.filter(item =>
                        item.order && item.order.includes(orderNumber)
                    );
                }

                // === Enrich orders with Parent SFC (asynchronously for each row) ===

                // For each order, if ACTIVE, call detail API to get SFCs and pick Parent SFC
                const enhancedOrders = await Promise.all(ordersList.map(async (orderObj) => {
                    let parentSFC = "-";
                    let dmReleasedQty = "-"; // Default
                    if (orderObj.executionStatus === "ACTIVE") {
                        const orderDetailUrl = `${this.getPublicApiRestDataSourceUri()}/order/v1/orders?plant=${encodeURIComponent(oPlant)}&order=${encodeURIComponent(orderObj.order)}`;
                        try {
                            const orderDetailResponse = await fetch(orderDetailUrl);
                            if (orderDetailResponse.ok) {
                                const orderDetailData = await orderDetailResponse.json();
                                let sfcs = orderDetailData.sfcs || [];
                                let releasedQuantity = orderDetailData.releasedQuantity;
                
                                // Find first SFC containing the order string (case-sensitive)
                                let foundSFC = undefined;
                                if (orderObj.order && Array.isArray(sfcs)) {
                                    foundSFC = sfcs.find(sfcName => sfcName.includes(orderObj.order));
                                }
                                if (foundSFC) {
                                    parentSFC = foundSFC;
                                    // Calculate DM Released Qty as per logic
                                    if (typeof releasedQuantity === "number" && Array.isArray(sfcs)) {
                                        const uom =
                                            orderDetailData.productionUnitOfMeasure ||
                                            orderDetailData.erpUnitOfMeasure ||
                                            (orderDetailData.productionUnitOfMeasureObject && orderDetailData.productionUnitOfMeasureObject.uom) ||
                                            (orderDetailData.baseUnitOfMeasureObject && orderDetailData.baseUnitOfMeasureObject.uom) ||
                                            "";
                                        dmReleasedQty = (releasedQuantity - sfcs.length + 1).toString() + (uom ? " " + uom : "");
                                    }                                    
                                } else {
                                    parentSFC = "-";
                                    dmReleasedQty = "-";
                                }
                            }
                        } catch (error) {
                            parentSFC = "-";
                            dmReleasedQty = "-";
                        }
                    }
                    const mappedOrder = mapOrderApiToUiRow(orderObj);
                    mappedOrder.parentSFC = parentSFC;
                    mappedOrder.dmReleasedQty = dmReleasedQty;
                    return mappedOrder;
                }));                

                // Bind final, enriched list to table model for display
                this.getView().getModel("orderModel").setProperty("/orders", enhancedOrders);
                this.getView().getModel("orderModel").setProperty("/selectedOrderNo", "");  // RESET selection here

                // Update item count in table heading
                if (oItemsHeading && oItemsHeading.setText) {
                    oItemsHeading.setText(`Items (${enhancedOrders.length.toString().padStart(2, "0")})`);
                }
            })
            .catch(err => {
                // Any error: show user-friendly message, clear table, reset count
                MessageToast.show("Failed to fetch orders: " + err.message);
                this.getView().getModel("orderModel").setProperty("/orders", []);
                if (oItemsHeading && oItemsHeading.setText) {
                    oItemsHeading.setText("Items (00)");
                }
            });
        },

        // === Radio button selection handler ===
        onRadioSelect: function(oEvent) {
            // Find the order number of the row where selection happened
            var oContext = oEvent.getSource().getBindingContext("orderModel");
            var orderNo = oContext.getProperty("orderNo");
            this.getView().getModel("orderModel").setProperty("/selectedOrderNo", orderNo);
        },

        /**
         * Wrapper utility for AJAX GET requests (legacy fallback in this app).
         * Calls provided success/error callbacks.
         */
        executeAjaxGetRequestSuccessCallback: function (sUrl, oParameters, fnSuccessCallback, fnErrorCallback) {
            this.ajaxGetRequest(
                sUrl,
                oParameters,
                (oResponse) => {
                    if (fnSuccessCallback) {
                        fnSuccessCallback(oResponse);
                    }
                },
                (oError, sHttpErrorMessage) => {
                    if (fnErrorCallback) {
                        fnErrorCallback(oError);
                    } else {
                        Log.error("AJAX GET failed:", sHttpErrorMessage, oError);
                        MessageToast.show("AJAX request failed.");
                    }
                }
            );
        }
    });
});
