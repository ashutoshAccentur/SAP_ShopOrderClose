sap.ui.define([
    "sap/ui/model/json/JSONModel",
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/base/Log",
    "sap/m/MessageToast"
], function (JSONModel, PluginViewController, Log, MessageToast) {
    "use strict";

    // === Helpers ===
    function getOrderUOM(orderApiObj) {
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

    function formatDate(dateStr) {
        if (!dateStr) return "-";
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return "-";
            // Format: DD/MM/YYYY, hh:mm:ss am/pm (Indian)
            // Pad day/month with leading zero if needed
            const day = String(date.getDate()).padStart(2, "0");
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const year = date.getFullYear();
            // Local time:
            let time = date.toLocaleTimeString("en-IN", { hour12: true });
            return `${day}/${month}/${year}, ${time}`;
        } catch {
            return "-";
        }
    }

    function parseDatePickerValue(oDatePicker) {
        if (!oDatePicker) return null;
        const value = oDatePicker.getValue();
        if (!value) return null;
        // Try parsing SAPUI5 DatePicker value (ISO, or user format)
        const dt = new Date(value);
        return isNaN(dt.getTime()) ? null : dt;
    }

    // Mapper: order object → UI row
    function mapOrderApiToUiRow(orderApiObj) {
        const uom = getOrderUOM(orderApiObj);
        return {
            orderNo: orderApiObj.order || "-",
            parentSFC: "-",
            materialLine: orderApiObj.material
                ? (orderApiObj.material.material + " / " + (orderApiObj.material.version || ""))
                : "-",
            materialDesc: orderApiObj.material?.description || "",
            executionStatus: orderApiObj.executionStatus || "-",
            buildQty: orderApiObj.buildQuantity !== undefined ? orderApiObj.buildQuantity + " " + uom : "-",
            doneQty: orderApiObj.doneQuantity !== undefined ? orderApiObj.doneQuantity + " " + uom : "-",
            dmReleasedQty: orderApiObj.dmReleasedQty !== undefined ? orderApiObj.dmReleasedQty + " " + uom : "-",
            availableQty:
            (orderApiObj.buildQuantity !== undefined && orderApiObj.doneQuantity !== undefined)
              ? (orderApiObj.buildQuantity - orderApiObj.doneQuantity) + " " + uom
              : "-",
            scheduledStartEnd: formatDate(orderApiObj.scheduledStartDate) + "\n" + formatDate(orderApiObj.scheduledCompletionDate),
            scheduledStartDate: orderApiObj.scheduledStartDate,
            scheduledCompletionDate: orderApiObj.scheduledCompletionDate,
            priority: orderApiObj.priority || "-"
        };
    }
    

    return PluginViewController.extend("bobm.custom.completeorderplugin.orderviewplugin.controller.OrderView", {
        metadata: { properties: {} },

        onInit: function () {
            if (PluginViewController.prototype.onInit) {
                PluginViewController.prototype.onInit.apply(this, arguments);
            }
            // Set empty orders model (for binding to table)
            this.getView().setModel(new JSONModel({ orders: [] }), "orderModel");
        },

        /**
         * Handler for Filter button press.
         * Gathers all filter inputs, validates, calls backend, binds results.
         */
        onFilterPress: function () {
            const oMaterial = this.byId("materialInput");
            const oExecutionStatus = this.byId("executionStatusSelect");
            const oOrderNo = this.byId("orderNoInput");
            const oDateFrom = this.byId("dateFromInput");
            const oDateTo = this.byId("dateToInput");
            const oItemsHeading = this.byId("itemsHeading");
        
            const material = oMaterial ? oMaterial.getValue().trim() : "";
            const executionStatus = oExecutionStatus ? oExecutionStatus.getSelectedKey() : "";
            const orderNumber = oOrderNo ? oOrderNo.getValue().trim() : "";
            const dateFromObj = parseDatePickerValue(oDateFrom);
            const dateToObj = parseDatePickerValue(oDateTo);
        
            if (!material) {
                MessageToast.show("Material is mandatory.");
                return;
            }
            if (dateFromObj && dateToObj && dateFromObj > dateToObj) {
                MessageToast.show("Date From cannot be later than Date To.");
                return;
            }
        
            const dateFromStr = dateFromObj ? dateFromObj.toISOString().substring(0, 10) : null;
            const dateToStr = dateToObj ? dateToObj.toISOString().substring(0, 10) : null;
        
            const oPlant = this.getPodController().getUserPlant();  // Dynamic plant from model oPlant
            const sListUrl = this.getPublicApiRestDataSourceUri() + "/order/v1/orders/list";
        
            const params = { plant: oPlant, material: material };
            if (executionStatus) params.executionStatus = executionStatus;
            if (orderNumber) params.orderNumber = orderNumber;
            if (dateFromStr) params.dateFrom = dateFromStr;
            if (dateToStr) params.dateTo = dateToStr;
        
            // --- Fetch orders from backend ---
            fetch(sListUrl + "?" + new URLSearchParams(params).toString())
            .then(response => {
                if (!response.ok) throw new Error("Server/API error");
                return response.json();
            })
            .then(async apiData => {
                let ordersList = apiData.content || [];
        
                // Filter client-side by date range
                if (dateFromObj && dateToObj) {
                    ordersList = ordersList.filter(item => {
                        if (!item.scheduledStartDate || !item.scheduledCompletionDate) return false;
                        const itemStart = new Date(item.scheduledStartDate);
                        const itemEnd = new Date(item.scheduledCompletionDate);
                        return (itemStart >= dateFromObj && itemEnd <= dateToObj);
                    });
                }
        
                // Apply executionStatus filter if specified
                if (executionStatus) {
                    ordersList = ordersList.filter(item =>
                        item.executionStatus && item.executionStatus === executionStatus
                    );
                }

                // --- Client-side filter for order number (add this block) ---
                if (orderNumber) {
                    ordersList = ordersList.filter(item =>
                        item.order && item.order.includes(orderNumber)
                    );
                }
        
                // Get Parent SFC only for ACTIVE orders
                const enhancedOrders = await Promise.all(ordersList.map(async (orderObj) => {
                    let parentSFC = "-";
                    if (orderObj.executionStatus === "ACTIVE") {
                        const orderDetailUrl = `${this.getPublicApiRestDataSourceUri()}/order/v1/orders?plant=${encodeURIComponent(oPlant)}&order=${encodeURIComponent(orderObj.order)}`;
                        try {
                            const orderDetailResponse = await fetch(orderDetailUrl);
                            if (orderDetailResponse.ok) {
                                const orderDetailData = await orderDetailResponse.json();
                                let sfcs = orderDetailData.sfcs || [];
                                if (orderObj.order && Array.isArray(sfcs)) {
                                    const found = sfcs.find(sfcName => sfcName.includes(orderObj.order));
                                    parentSFC = found ? found : "-";
                                } else {
                                    parentSFC = "-";
                                }
                            }
                        } catch (error) {
                            parentSFC = "-";
                        }
                    }
                    const mappedOrder = mapOrderApiToUiRow(orderObj);
                    mappedOrder.parentSFC = parentSFC;
                    return mappedOrder;
                }));                
        
                this.getView().getModel("orderModel").setProperty("/orders", enhancedOrders);
        
                if (oItemsHeading && oItemsHeading.setText) {
                    oItemsHeading.setText(`Items (${enhancedOrders.length.toString().padStart(2, "0")})`);
                }
            })
            .catch(err => {
                MessageToast.show("Failed to fetch orders: " + err.message);
                this.getView().getModel("orderModel").setProperty("/orders", []);
                if (oItemsHeading && oItemsHeading.setText) {
                    oItemsHeading.setText("Items (00)");
                }
            });
        },



        // --- (Keep this for other GET requests in app) ---
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
