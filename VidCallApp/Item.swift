//
//  Item.swift
//  VidCallApp
//
//  Created by Bruno Talledo on 4/11/25.
//

import Foundation
import SwiftData

@Model
final class Item {
    var timestamp: Date
    
    init(timestamp: Date) {
        self.timestamp = timestamp
    }
}
